'use client';

import type { RoomView } from '@mm/game-core';
import { CARD_KIND_LABELS, type CardKind } from '@mm/shared';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { formatClock, secondsLeft } from '../lib/time';
import { useGameSocket, type GameSocket } from '../lib/useGameSocket';

const PHASE_LABEL: Record<RoomView['phase'], string> = {
  INTRO: '導入',
  CONFIRM: '確認',
  REVEAL: 'カード公開',
  TALK: '会話',
  VOTE: '投票',
  RESULT: '結果',
  CLOSED: '終了',
};

function phaseTitle(view: RoomView): string {
  const base = PHASE_LABEL[view.phase];
  return view.phase === 'REVEAL' || view.phase === 'TALK' ? `第${view.setNo}セット：${base}` : base;
}

/**
 * 席が人間からNPCに切り替わったことを知らせる（仕様書 §7.4）。
 * 状態の変化から検出するので、再接続の直後は通知しない。
 */
function useSwitchNotices(view: RoomView | null): string[] {
  const previous = useRef<Map<number, string> | null>(null);
  const [notices, setNotices] = useState<{ id: number; text: string }[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    if (!view) return;
    const kinds = new Map(view.seats.map((s) => [s.seat, s.kind]));
    const before = previous.current;
    previous.current = kinds;
    if (!before) return;
    for (const seat of view.seats) {
      if (before.get(seat.seat) === 'human' && seat.kind === 'npc') {
        const id = nextId.current++;
        setNotices((list) => [...list, { id, text: `${seat.name}が NPC に切り替わりました` }]);
        setTimeout(() => setNotices((list) => list.filter((n) => n.id !== id)), 15000);
      }
    }
  }, [view]);

  return notices.map((n) => n.text);
}

export function GameRoom({ roomId }: { roomId: string }) {
  const socket = useGameSocket(roomId);
  const { view, connection, closeReason } = socket;
  const switchNotices = useSwitchNotices(view);
  const phase = view?.phase;
  const setNo = view?.setNo;

  // 画面が切り替わるとき（導入→確認→…→結果）は、ページの先頭から読めるようにする
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [phase, setNo]);

  if (connection === 'closed') {
    return (
      <>
        <h1>接続できません</h1>
        <p className="error">{closeReason}</p>
        <Link href="/">ホームへ戻る</Link>
      </>
    );
  }
  if (!view) return <p className="muted">ルームに接続しています…</p>;

  const nameOf = (seat: number) => view.seats.find((s) => s.seat === seat)?.name ?? '?';

  return (
    <>
      <Header socket={socket} view={view} />
      <Banners socket={socket} />
      {switchNotices.map((text, i) => (
        <div key={i} className="banner">
          {text}
        </div>
      ))}
      {view.phase === 'INTRO' || view.phase === 'CONFIRM' ? (
        // 冒頭文・状況文の初表示は、読むことに集中できるよう画面いっぱいに出す
        <div className={view.phase === 'CONFIRM' ? 'wide wider' : 'wide'}>
          <IntroPanel view={view} />
          {view.phase === 'CONFIRM' ? (
            // 登場人物は、状況文を読みながら見比べられるよう横（狭い画面では上）に置く
            <div className="confirm-grid">
              <div className="confirm-seats">
                <SeatsPanel view={view} />
              </div>
              <div className="confirm-main">
                <PhaseMain socket={socket} view={view} nameOf={nameOf} />
              </div>
            </div>
          ) : (
            <PhaseMain socket={socket} view={view} nameOf={nameOf} />
          )}
        </div>
      ) : (
        <div className="layout">
          <aside>
            <IntroPanel view={view} />
            <MyPanel view={view} />
          </aside>
          <section>
            <PhaseMain socket={socket} view={view} nameOf={nameOf} />
          </section>
          <aside>
            <SeatsPanel view={view} />
            <RevealedPanel view={view} nameOf={nameOf} />
          </aside>
        </div>
      )}
    </>
  );
}

function Countdown({ view, offsetMs }: { view: RoomView; offsetMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = secondsLeft(view.deadlineAt, offsetMs, now);
  if (left === null) return null;
  return <span className={`timer ${left <= 10 ? 'low' : ''}`}>{formatClock(left)}</span>;
}

function Header({ socket, view }: { socket: GameSocket; view: RoomView }) {
  return (
    <div className="row spread">
      <h1>{phaseTitle(view)}</h1>
      <Countdown view={view} offsetMs={socket.offsetMs} />
    </div>
  );
}

function Banners({ socket }: { socket: GameSocket }) {
  return (
    <>
      {socket.connection === 'reconnecting' && (
        <div className="banner danger">接続が切れました。再接続しています…</div>
      )}
      {socket.warnSec !== null && !socket.spectator && (
        <div className="banner danger">
          しばらく操作がありません。あと約 {socket.warnSec} 秒で NPC に交代します。
        </div>
      )}
      {socket.spectator && (
        <div className="banner">
          {socket.switched
            ? '操作がなかったため、あなたの席は NPC に交代しました。以降は観戦のみです。'
            : '観戦中です。操作はできません。'}
        </div>
      )}
      {socket.error && <div className="banner danger">{socket.error}</div>}
    </>
  );
}

/** 冒頭文。あとから読み返せるよう、折りたたんで常に置いておく（被害者の名前などを確認するため）。 */
function IntroPanel({ view }: { view: RoomView }) {
  if (view.phase === 'INTRO') return null; // 導入では本文を主画面に出している
  return (
    <details className="panel fold">
      <summary>事件の発端（冒頭文）</summary>
      <p className="prose">{view.introText}</p>
    </details>
  );
}

/** カードの種類（目撃証言／証拠品）。仕様書 §4.3.1 */
function KindLabel({ kind }: { kind: CardKind }) {
  return <span className={`kind ${kind}`}>{CARD_KIND_LABELS[kind]}</span>;
}

/** 犯人の画面でだけ、捏造カードに印を付ける。 */
function FabricatedBadge({ view, cardId }: { view: RoomView; cardId: string }) {
  if (view.me.fabricatedCard?.card.id !== cardId) return null;
  return <span className="badge danger">捏造</span>;
}

function HandCards({ view }: { view: RoomView }) {
  return (
    <>
      <h3>手札</h3>
      <div style={{ display: 'grid', gap: 8 }}>
        {view.me.cards.map((c) => (
          <div key={c.id} className={`card ${c.revealed ? 'revealed' : ''}`}>
            <h4>
              <KindLabel kind={c.kind} />
              {c.title}
              {c.revealed && <span className="badge">公開済み</span>}
              <FabricatedBadge view={view} cardId={c.id} />
            </h4>
            <div className="prose">{c.body}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function CulpritNotice({ view }: { view: RoomView }) {
  if (!view.me.isCulprit) return null;
  const f = view.me.fabricatedCard;
  const holder = f && view.seats.find((s) => s.seat === f.seat)?.name;
  return (
    <>
      <p className="error">
        <strong>あなたが犯人です。</strong>正体を隠し通してください。
      </p>
      {f && f.seat === view.me.seat && (
        <p className="muted">
          手札の「{f.card.title}」は、あなたが作った<strong>捏造カード</strong>
          です。出すかどうか、いつ出すかはあなたが決められます。
        </p>
      )}
      {f && f.seat !== view.me.seat && (
        <div className="card compact">
          <h4>
            <KindLabel kind={f.card.kind} />
            {f.card.title}
            <span className="badge danger">捏造</span>
          </h4>
          <div className="prose">{f.card.body}</div>
          <p className="muted">
            {holder}の手札にある、あなたが仕込んだ<strong>捏造カード</strong>
            です。{holder}本人は真実だと信じています。
          </p>
        </div>
      )}
    </>
  );
}

/** 会話中などの左欄。状況文は折りたたみで、クリックしたときだけ読める。 */
function MyPanel({ view }: { view: RoomView }) {
  const me = view.seats.find((s) => s.seat === view.me.seat)!;
  return (
    <div className="panel">
      <h2>あなた：{me.name}</h2>
      <CulpritNotice view={view} />
      <details className="fold">
        <summary>自分の状況（クリックで開く）</summary>
        <p className="prose">{view.me.situationText}</p>
      </details>
      <HandCards view={view} />
    </div>
  );
}

/** 確認フェーズ。自分の状況文と手札を、画面いっぱいに出す。 */
function ConfirmScreen({
  socket,
  view,
  disabled,
}: {
  socket: GameSocket;
  view: RoomView;
  disabled: boolean;
}) {
  const me = view.seats.find((s) => s.seat === view.me.seat)!;
  return (
    <div className="panel big">
      <h2>あなたは {me.name} です</h2>
      <p className="muted">{me.publicProfile}</p>
      <CulpritNotice view={view} />
      <h3>あなただけが知っている状況</h3>
      <p className="prose">{view.me.situationText}</p>
      <HandCards view={view} />
      <p className="muted">
        手札は、会話のあと1枚ずつ全員に公開していきます。読み終えたら「準備完了」を押してください。
      </p>
      <ReadyButton socket={socket} view={view} label="準備完了" disabled={disabled} />
    </div>
  );
}

function SeatsPanel({ view }: { view: RoomView }) {
  const marks = (seat: number): string[] => {
    const out: string[] = [];
    if (view.phase === 'INTRO' || view.phase === 'CONFIRM') {
      if (view.readySeats.includes(seat)) out.push('準備完了');
    }
    if (view.phase === 'REVEAL' && view.pickedSeats.includes(seat)) out.push('選択済み');
    if (view.phase === 'TALK' && view.agreedEndSeats.includes(seat)) out.push('話し終えた');
    if (view.phase === 'VOTE' && view.votedSeats.includes(seat)) out.push('投票済み');
    return out;
  };

  return (
    <div className="panel">
      <h2>登場人物</h2>
      <ul className="plain">
        {view.victim && (
          <li>
            <strong>{view.victim.name}</strong>
            <span className="badge danger">被害者</span>
            <div className="muted">{view.victim.profile}</div>
          </li>
        )}
        {view.seats.map((s) => (
          <li key={s.seat}>
            <strong>{s.name}</strong>
            {s.seat === view.me.seat && <span className="badge ok">あなた</span>}
            <span className={`badge ${s.kind === 'npc' ? 'npc' : ''}`}>
              {s.kind === 'npc' ? 'NPC' : '人間'}
            </span>
            {marks(s.seat).map((m) => (
              <span key={m} className="badge ok">
                {m}
              </span>
            ))}
            <div className="muted">{s.publicProfile}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RevealedPanel({ view, nameOf }: { view: RoomView; nameOf: (seat: number) => string }) {
  const [byPerson, setByPerson] = useState(true);
  const groups = byPerson
    ? view.seats.map((seat) => ({
        key: String(seat.seat),
        title: seat.name,
        items: view.revealed.filter((r) => r.seat === seat.seat),
      }))
    : [1, 2, 3].map((setNo) => ({
        key: String(setNo),
        title: `第${setNo}セット`,
        items: view.revealed.filter((r) => r.setNo === setNo),
      }));

  return (
    <div className="panel">
      <div className="row spread">
        <h2>公開されたカード</h2>
        <button className="secondary" onClick={() => setByPerson(!byPerson)}>
          {byPerson ? 'セット順で見る' : '人物別で見る'}
        </button>
      </div>
      <p className="muted">
        カードは原則として事実ですが、全16枚のうち1枚だけ捏造カードがあります。
      </p>
      {view.revealed.length === 0 && <p className="muted">まだ公開されていません。</p>}
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <div key={g.key} className="group">
            <h3>{g.title}</h3>
            {g.items.map((r) => (
              <div
                key={r.card.id}
                className={`card compact ${r.setNo === view.setNo ? 'latest' : ''}`}
              >
                <h4>
                  <KindLabel kind={r.card.kind} />
                  {r.card.title}
                  <span className="badge">{byPerson ? `第${r.setNo}セット` : nameOf(r.seat)}</span>
                  <FabricatedBadge view={view} cardId={r.card.id} />
                </h4>
                <div className="prose">{r.card.body}</div>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

function PhaseMain({
  socket,
  view,
  nameOf,
}: {
  socket: GameSocket;
  view: RoomView;
  nameOf: (seat: number) => string;
}) {
  const disabled = socket.spectator;
  switch (view.phase) {
    case 'INTRO':
      return (
        <div className="panel big">
          <h2>事件の発端</h2>
          <p className="prose">{view.introText}</p>
          <ReadyButton socket={socket} view={view} label="読み終えた" disabled={disabled} />
        </div>
      );
    case 'CONFIRM':
      return <ConfirmScreen socket={socket} view={view} disabled={disabled} />;
    case 'REVEAL':
      return <RevealPick socket={socket} view={view} disabled={disabled} />;
    case 'TALK':
      return <Talk socket={socket} view={view} nameOf={nameOf} disabled={disabled} />;
    case 'VOTE':
      return <Vote socket={socket} view={view} disabled={disabled} />;
    default:
      return <Result socket={socket} view={view} nameOf={nameOf} disabled={disabled} />;
  }
}

function ReadyButton({
  socket,
  view,
  label,
  disabled,
}: {
  socket: GameSocket;
  view: RoomView;
  label: string;
  disabled: boolean;
}) {
  const done = view.readySeats.includes(view.me.seat);
  return (
    <div className="row">
      <button disabled={disabled || done} onClick={() => socket.send({ type: 'ready' })}>
        {done ? '他の人を待っています…' : label}
      </button>
      <span className="muted">NPC の席は待ちません。</span>
    </div>
  );
}

function RevealPick({
  socket,
  view,
  disabled,
}: {
  socket: GameSocket;
  view: RoomView;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const available = view.me.cards.filter((c) => !c.revealed);
  const done = view.myPick !== null;

  return (
    <div className="panel">
      <h2>公開するカードを1枚選んでください</h2>
      <p className="muted">
        全員が選ぶか時間切れになると、4枚が同時に公開されます。カードは原則として事実ですが、全16枚のうち1枚だけ捏造カードがあります。
      </p>
      <div className="cards" style={{ marginBottom: 12 }}>
        {available.map((c) => {
          const chosen = done ? view.myPick === c.id : selected === c.id;
          return (
            <div
              key={c.id}
              className={`card selectable ${chosen ? 'selected' : ''}`}
              onClick={() => !done && !disabled && setSelected(c.id)}
            >
              <h4>
                <KindLabel kind={c.kind} />
                {c.title}
                <FabricatedBadge view={view} cardId={c.id} />
              </h4>
              <div className="prose">{c.body}</div>
            </div>
          );
        })}
      </div>
      <button
        disabled={disabled || done || !selected}
        onClick={() => selected && socket.send({ type: 'pickCard', cardId: selected })}
      >
        {done ? '他の人を待っています…' : 'このカードを公開する'}
      </button>
    </div>
  );
}

type ChatMessage = RoomView['chat'][number];

function ChatLog({
  messages,
  nameOf,
  empty,
}: {
  messages: ChatMessage[];
  nameOf: (seat: number) => string;
  empty: string;
}) {
  const box = useRef<HTMLDivElement>(null);

  // 会話欄の中だけを最新の発言までスクロールする（scrollIntoView だとページ全体も動いてしまう）
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div className="chat" ref={box}>
      {messages.length === 0 && <p className="muted">{empty}</p>}
      {messages.map((m) => (
        <p key={m.id}>
          <span className="who">{nameOf(m.seat)}</span>
          {m.body}
        </p>
      ))}
    </div>
  );
}

function ChatInput({
  socket,
  disabled,
  children,
}: {
  socket: GameSocket;
  disabled: boolean;
  children?: React.ReactNode;
}) {
  const [text, setText] = useState('');

  const send = () => {
    const body = text.trim();
    if (!body || disabled) return;
    socket.send({ type: 'chat', body });
    setText('');
  };

  return (
    <div className="row">
      <input
        type="text"
        value={text}
        maxLength={200}
        placeholder="発言を入力（Enterで送信）"
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) send();
        }}
        style={{ flex: 1, minWidth: 200 }}
      />
      <button disabled={disabled || !text.trim()} onClick={send}>
        送信
      </button>
      {children}
    </div>
  );
}

/** 席 seat のセット setNo での会話相手。サーバー（game-core の partnerOf）と同じ規則。 */
const partnerOf = (seat: number, setNo: number) => seat ^ setNo;

function Talk({
  socket,
  view,
  nameOf,
  disabled,
}: {
  socket: GameSocket;
  view: RoomView;
  nameOf: (seat: number) => string;
  disabled: boolean;
}) {
  const agreed = view.agreedEndSeats.includes(view.me.seat);
  const partner = partnerOf(view.me.seat, view.setNo);
  const current = view.chat.filter((m) => m.scope === 'pair' && m.setNo === view.setNo);
  const past = view.chat.filter((m) => m.scope === 'pair' && m.setNo < view.setNo);

  return (
    <div className="panel">
      <h2>{nameOf(partner)}さんと2人で会話</h2>
      <p className="muted">この会話は、あなたと{nameOf(partner)}さんにしか見えません。</p>
      <ChatLog messages={current} nameOf={nameOf} empty="まだ発言がありません。" />
      <p className="muted typing">{view.partnerTyping ? `${nameOf(partner)}が入力中…` : ' '}</p>
      <ChatInput socket={socket} disabled={disabled}>
        <button
          className="secondary"
          disabled={disabled || agreed}
          onClick={() => socket.send({ type: 'agreeEndTalk' })}
        >
          {agreed ? '他の人を待っています…' : '話し終えた'}
        </button>
      </ChatInput>
      <p className="muted">全員が「話し終えた」を押すと、時間前でも次へ進みます。</p>
      {past.length > 0 && (
        <details>
          <summary>前の回の会話を見る</summary>
          {[...new Set(past.map((m) => m.setNo))].map((setNo) => (
            <div key={setNo}>
              <h3>
                第{setNo}セット：{nameOf(partnerOf(view.me.seat, setNo))}さんとの会話
              </h3>
              <ChatLog messages={past.filter((m) => m.setNo === setNo)} nameOf={nameOf} empty="" />
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function Vote({
  socket,
  view,
  disabled,
}: {
  socket: GameSocket;
  view: RoomView;
  disabled: boolean;
}) {
  const [target, setTarget] = useState<number | null>(null);
  const done = view.votedSeats.includes(view.me.seat);
  const candidates = view.seats.filter((s) => s.seat !== view.me.seat);

  return (
    <div className="panel">
      <h2>犯人だと思う人に投票してください</h2>
      <p className="muted">
        最多得票の人が犯人なら、犯人以外の勝ちです。同数や無投票なら、犯人の勝ちです。
      </p>
      <ul className="plain" style={{ marginBottom: 12 }}>
        {candidates.map((s) => (
          <li key={s.seat}>
            <label style={{ margin: 0 }}>
              <input
                type="radio"
                name="vote"
                disabled={disabled || done}
                checked={target === s.seat}
                onChange={() => setTarget(s.seat)}
              />{' '}
              {s.name}
            </label>
          </li>
        ))}
      </ul>
      <button
        disabled={disabled || done || target === null}
        onClick={() => target !== null && socket.send({ type: 'vote', targetSeat: target })}
      >
        {done ? '他の人を待っています…' : '投票する'}
      </button>
    </div>
  );
}

function Result({
  socket,
  view,
  nameOf,
  disabled,
}: {
  socket: GameSocket;
  view: RoomView;
  nameOf: (seat: number) => string;
  disabled: boolean;
}) {
  const r = view.resultView;
  if (!r) return <p className="muted">結果を待っています…</p>;
  const culprit = r.result.culpritSeat;
  const iWon = r.result.outcomes.find((o) => o.seat === view.me.seat)?.outcome === 'win';
  const iAmCulprit = view.me.seat === culprit;

  return (
    <>
      <div className="panel">
        <h2>
          {r.result.winner === 'detectives' ? '犯人以外の勝利' : '犯人の勝利'}
          {iWon && <span className="badge ok">あなたの勝ち</span>}
        </h2>
        <p>
          犯人は <strong>{nameOf(culprit)}</strong>
          {iAmCulprit ? '（あなたです）' : ''} でした。
        </p>
        <h3>得票</h3>
        <ul className="plain">
          {view.seats.map((s) => (
            <li key={s.seat}>
              {s.name}：{r.result.tally[s.seat]} 票
              <span className="muted">
                {' '}
                （投票先：
                {(() => {
                  const v = r.votes.find((x) => x.seat === s.seat)?.target;
                  return v === null || v === undefined ? '棄権' : nameOf(v);
                })()}
                ）
              </span>
            </li>
          ))}
        </ul>
        <p className="muted">同数で並んだ場合や、誰も投票しなかった場合は、犯人の勝ちです。</p>
      </div>

      <div className="panel">
        <h2>真相</h2>
        <p className="prose">{r.endingText}</p>
      </div>

      <div className="panel">
        <h2>全員の手札</h2>
        {r.hands.map((h) => (
          <div key={h.seat} style={{ marginBottom: 12 }}>
            <h3>{nameOf(h.seat)}</h3>
            <div className="cards">
              {h.cards.map((c) => (
                <div key={c.id} className={`card ${c.revealed ? 'revealed' : ''}`}>
                  <h4>
                    <KindLabel kind={c.kind} />
                    {c.title}
                    {!c.revealed && <span className="badge npc">未公開</span>}
                    {c.fabricated && <span className="badge danger">捏造</span>}
                  </h4>
                  <div className="prose">{c.body}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>感想戦</h2>
        <p className="muted">全員で話せます。NPCは発言しません。</p>
        <ChatLog
          messages={view.chat.filter((m) => m.scope === 'all')}
          nameOf={nameOf}
          empty="まだ発言がありません。"
        />
        <ChatInput socket={socket} disabled={disabled || view.phase !== 'RESULT'} />
      </div>

      <div className="panel">
        <h2>各組の会話</h2>
        <p className="muted">プレイ中は、自分の組の会話しか見えませんでした。</p>
        {[1, 2, 3].map((setNo) => (
          <details key={setNo}>
            <summary>第{setNo}セット</summary>
            {view.seats
              .filter((s) => s.seat < partnerOf(s.seat, setNo))
              .map((s) => {
                const other = partnerOf(s.seat, setNo);
                return (
                  <div key={s.seat}>
                    <h3>
                      {nameOf(s.seat)} と {nameOf(other)}
                    </h3>
                    <ChatLog
                      messages={view.chat.filter(
                        (m) =>
                          m.scope === 'pair' &&
                          m.setNo === setNo &&
                          (m.seat === s.seat || m.seat === other),
                      )}
                      nameOf={nameOf}
                      empty="発言はありませんでした。"
                    />
                  </div>
                );
              })}
          </details>
        ))}
      </div>

      <Link href="/">
        <button>ホームへ戻る</button>
      </Link>
    </>
  );
}
