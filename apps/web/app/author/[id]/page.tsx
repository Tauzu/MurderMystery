'use client';

import {
  CARD_KIND_LABELS,
  checkScenarioStructure,
  CONSISTENCY_LABELS,
  MODERATION_LABELS,
  SCENARIO_LIMITS,
  type ScenarioCheckResult,
} from '@mm/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pending } from '../../../components/Pending';
import { ApiError, api } from '../../../lib/api';
import {
  generalIssues,
  issuesByPath,
  normalizeDraft,
  setCulprit,
  setFabricated,
  toPayload,
  type Draft,
} from '../../../lib/draft';
import { useRequireUser } from '../../../lib/useUser';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
const AUTOSAVE_MS = 1500;
const POLL_MS = 2000;

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  limit: readonly [number, number];
  /** 入力欄の位置。指摘の表示に使う */
  path: string;
  issues: Map<string, string>;
  multiline?: boolean;
  rows?: number;
}

/** 文字数つきの入力欄。入力が始まった欄、または一度離れた欄にだけ指摘を出す。 */
function Field({ label, value, onChange, limit, path, issues, multiline, rows }: FieldProps) {
  const [touched, setTouched] = useState(false);
  const issue = issues.get(path);
  const show = issue && (touched || value !== '');
  const len = [...value].length;
  const common = {
    value,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    onBlur: () => setTouched(true),
    'aria-invalid': show ? true : undefined,
  };
  return (
    <label>
      <span className="row spread">
        <span>{label}</span>
        <span className={len > limit[1] || (touched && len < limit[0]) ? 'error' : 'muted'}>
          {len} / {limit[1]}
        </span>
      </span>
      {multiline ? <textarea rows={rows ?? 4} {...common} /> : <input type="text" {...common} />}
      {show && <span className="error">{issue}</span>}
    </label>
  );
}

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, error } = useRequireUser();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [check, setCheck] = useState<ScenarioCheckResult | null>(null);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  const draftRef = useRef<Draft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<boolean> | null>(null);

  // 読み込み
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api<{ scenario: { status: string; draft: unknown } }>(
          `/me/scenarios/${id}`,
        );
        if (cancelled) return;
        if (r.scenario.status !== 'draft') {
          setLoadError('公開したミステリーは編集できません。');
          return;
        }
        const d = normalizeDraft(r.scenario.draft);
        draftRef.current = d;
        setDraft(d);
        const c = await api<{ check: ScenarioCheckResult | null; stale: boolean }>(
          `/scenarios/${id}/check`,
        );
        if (cancelled) return;
        setCheck(c.check);
        setStale(c.stale);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof ApiError ? e.message : '読み込めませんでした');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, id]);

  /** 保存する。保存中に内容が変わっていたら、続けてもう一度保存する。 */
  const save = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (saving.current) {
      await saving.current;
    }
    const d = draftRef.current;
    if (!d) return false;
    setSaveState('saving');
    const run = (async () => {
      try {
        await api(`/scenarios/${id}`, { method: 'PUT', body: { draft: toPayload(d) } });
        // 保存中にさらに編集されていれば、まだ未保存
        setSaveState(draftRef.current === d ? 'saved' : 'dirty');
        return true;
      } catch (e) {
        setSaveState('error');
        setMessage(e instanceof ApiError ? e.message : '保存できませんでした');
        return false;
      }
    })();
    saving.current = run;
    const ok = await run;
    saving.current = null;
    if (ok && draftRef.current !== d) return save();
    return ok;
  }, [id]);

  const update = (next: Draft) => {
    draftRef.current = next;
    setDraft(next);
    setSaveState('dirty');
    setStale(true);
    setAcknowledged(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
  };

  // 画面を離れるときに、未保存があれば警告する
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveState === 'dirty' || saveState === 'saving' || saveState === 'error') {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveState]);

  // チェックの完了を待つ
  useEffect(() => {
    if (check?.status !== 'running') return;
    const t = setInterval(async () => {
      try {
        const c = await api<{ check: ScenarioCheckResult | null; stale: boolean }>(
          `/scenarios/${id}/check`,
        );
        setCheck(c.check);
        setStale(c.stale);
      } catch {
        // 次の確認で再試行する
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [check?.status, id]);

  const issues = useMemo(() => (draft ? checkScenarioStructure(toPayload(draft)) : []), [draft]);
  const byPath = useMemo(() => issuesByPath(issues), [issues]);
  const general = useMemo(() => generalIssues(issues), [issues]);

  if (loadError) {
    return (
      <div className="panel">
        <p className="error">{loadError}</p>
        <Link href="/author">一覧へ戻る</Link>
      </div>
    );
  }
  if (!user || !draft) return <Pending error={error} />;

  const startCheck = async () => {
    setMessage(null);
    setBusy(true);
    try {
      if (!(await save())) return;
      const r = await api<{ check: ScenarioCheckResult }>(`/scenarios/${id}/check`, {
        method: 'POST',
      });
      setCheck(r.check);
      setStale(false);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '通信に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!window.confirm('公開します。公開した後は、本文を変更できません。よろしいですか？')) return;
    setMessage(null);
    setBusy(true);
    try {
      await api(`/scenarios/${id}/publish`, {
        method: 'POST',
        body: { acknowledgeWarnings: acknowledged },
      });
      router.push('/author');
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '通信に失敗しました');
      setBusy(false);
    }
  };

  const setChar = (i: number, patch: Partial<Draft['characters'][number]>) =>
    update({
      ...draft,
      characters: draft.characters.map((c, k) => (k === i ? { ...c, ...patch } : c)),
    });
  const setCard = (
    i: number,
    j: number,
    patch: Partial<Draft['characters'][number]['cards'][number]>,
  ) =>
    update({
      ...draft,
      characters: draft.characters.map((c, k) =>
        k === i
          ? { ...c, cards: c.cards.map((card, l) => (l === j ? { ...card, ...patch } : card)) }
          : c,
      ),
    });

  const L = SCENARIO_LIMITS;
  const checkReady = check !== null && check.status === 'done' && !stale;
  const moderationOk = checkReady && check.moderation?.ok === true;
  const warn = checkReady && check.consistency?.verdict === 'warn';
  const canPublish = moderationOk && (!warn || acknowledged) && !busy && saveState === 'saved';

  return (
    <>
      <div className="row spread">
        <h1>ミステリーを作る</h1>
        <div className="row">
          <span className="muted">
            {
              {
                saved: '保存しました',
                dirty: '未保存の変更があります',
                saving: '保存中…',
                error: '保存に失敗しました',
              }[saveState]
            }
          </span>
          <button
            className="secondary"
            onClick={() => void save()}
            disabled={saveState === 'saved' || saveState === 'saving'}
          >
            今すぐ保存
          </button>
          <Link href="/author">一覧へ</Link>
        </div>
      </div>
      {message && <div className="banner danger">{message}</div>}

      <div className="panel">
        <h2>基本情報</h2>
        <Field
          label="タイトル"
          value={draft.title}
          onChange={(v) => update({ ...draft, title: v })}
          limit={L.title}
          path="title"
          issues={byPath}
        />
        <Field
          label="概要（一覧に表示。ネタバレなし）"
          value={draft.summary}
          onChange={(v) => update({ ...draft, summary: v })}
          limit={L.summary}
          path="summary"
          issues={byPath}
          multiline
          rows={2}
        />
        <Field
          label="冒頭文（事件の導入。全員に見える）"
          value={draft.introText}
          onChange={(v) => update({ ...draft, introText: v })}
          limit={L.introText}
          path="introText"
          issues={byPath}
          multiline
          rows={8}
        />
        <Field
          label="結末文（犯人の発表と真相の解説）"
          value={draft.endingText}
          onChange={(v) => update({ ...draft, endingText: v })}
          limit={L.endingText}
          path="endingText"
          issues={byPath}
          multiline
          rows={8}
        />
      </div>

      <div className="panel">
        <h2>被害者（任意）</h2>
        <Field
          label="名前"
          value={draft.victimName}
          onChange={(v) => update({ ...draft, victimName: v })}
          limit={L.characterName}
          path="victimName"
          issues={byPath}
        />
        <Field
          label="設定（全員に見える）"
          value={draft.victimProfile}
          onChange={(v) => update({ ...draft, victimProfile: v })}
          limit={L.publicProfile}
          path="victimProfile"
          issues={byPath}
          multiline
          rows={2}
        />
      </div>

      {draft.characters.map((c, i) => (
        <div className="panel" key={i}>
          <div className="row spread">
            <h2>キャラクター{i + 1}</h2>
            <label className="row">
              <input
                type="radio"
                name="culprit"
                checked={c.isCulprit}
                onChange={() => update(setCulprit(draft, i))}
              />
              犯人にする
            </label>
          </div>
          <Field
            label="名前"
            value={c.name}
            onChange={(v) => setChar(i, { name: v })}
            limit={L.characterName}
            path={`characters.${i}.name`}
            issues={byPath}
          />
          <Field
            label="公開用の設定（全員に見える）"
            value={c.publicProfile}
            onChange={(v) => setChar(i, { publicProfile: v })}
            limit={L.publicProfile}
            path={`characters.${i}.publicProfile`}
            issues={byPath}
            multiline
            rows={2}
          />
          <Field
            label="状況文（本人だけが読む。下の手札4枚の内容をすべて含めてください）"
            value={c.situationText}
            onChange={(v) => setChar(i, { situationText: v })}
            limit={L.situationText}
            path={`characters.${i}.situationText`}
            issues={byPath}
            multiline
            rows={8}
          />
          <h3>手札</h3>
          <div className="stack">
            {c.cards.map((card, j) => (
              <div className="card" key={j}>
                <div className="row spread">
                  <span className={`kind ${card.kind}`}>{CARD_KIND_LABELS[card.kind]}</span>
                  <label className="row">
                    <input
                      type="radio"
                      name="fabricated"
                      checked={card.isFabricated}
                      onClick={() => update(setFabricated(draft, i, j))}
                      onChange={() => undefined}
                    />
                    捏造カード（嘘の内容）にする
                  </label>
                </div>
                <Field
                  label="タイトル"
                  value={card.title}
                  onChange={(v) => setCard(i, j, { title: v })}
                  limit={L.cardTitle}
                  path={`characters.${i}.cards.${j}.title`}
                  issues={byPath}
                />
                <Field
                  label="内容"
                  value={card.body}
                  onChange={(v) => setCard(i, j, { body: v })}
                  limit={L.cardBody}
                  path={`characters.${i}.cards.${j}.body`}
                  issues={byPath}
                  multiline
                  rows={3}
                />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="panel">
        <h2>公開する</h2>
        {general.length > 0 && (
          <ul className="plain">
            {general.map((m) => (
              <li key={m} className="error">
                {m}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          入力の不足が {issues.length} 件あります。{issues.length === 0 && '（なし）'}
          {issues.length > 0 && '直すと、AIチェックを受けられます。'}
        </p>
        <button
          onClick={startCheck}
          disabled={busy || issues.length > 0 || check?.status === 'running'}
        >
          {check?.status === 'running' ? 'チェック中…' : 'AIチェックを受ける'}
        </button>
        <p className="muted">
          不適切表現と整合性を調べます。1日3回までです（同じ内容の結果の再表示は数えません）。
        </p>

        {check && <CheckView check={check} stale={stale} />}

        {warn && (
          <label className="row">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            整合性の指摘を確認した上で、このまま公開する
          </label>
        )}
        <button onClick={publish} disabled={!canPublish}>
          公開する
        </button>
        {!canPublish && (
          <p className="muted">
            今の内容でAIチェックを受け、不適切表現の指摘がなければ公開できます。
          </p>
        )}
      </div>
    </>
  );
}

function CheckView({ check, stale }: { check: ScenarioCheckResult; stale: boolean }) {
  if (check.status === 'running') return <p className="muted">AIが確認しています（30秒ほど）…</p>;
  if (check.status === 'error') {
    return (
      <p className="error">AIチェックに失敗しました：{check.error}。もう一度お試しください。</p>
    );
  }
  return (
    <div>
      {stale && (
        <div className="banner">
          内容を変更したため、この結果は古くなりました。もう一度チェックしてください。
        </div>
      )}
      <h3>不適切表現</h3>
      {check.moderation?.ok ? (
        <p>指摘はありません。</p>
      ) : (
        <ul className="plain">
          {check.moderation?.flags.map((f, i) => (
            <li key={i} className="error">
              [{MODERATION_LABELS[f.category]}] 「{f.where}」 {f.reason}
            </li>
          ))}
        </ul>
      )}
      <h3>整合性（助言）</h3>
      {check.consistency?.verdict === 'ok' ? (
        <p>指摘はありません。</p>
      ) : (
        <ul className="plain">
          {check.consistency?.findings.map((f, i) => (
            <li key={i}>
              <strong>{CONSISTENCY_LABELS[f.aspect]}</strong>：{f.message}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">整合性の指摘はAIの意見です。誤りを含むことがあります。</p>
    </div>
  );
}
