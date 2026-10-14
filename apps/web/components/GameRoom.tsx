'use client';

import type { RoomView } from '@mm/game-core';
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

export function GameRoom({ roomId }: { roomId: string }) {
  const socket = useGameSocket(roomId);
  const { view, connection, closeReason } = socket;

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
      <div className="layout">
        <aside>
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

/** 自分のキャラクター・状況文・手札。 */
function MyPanel({ view }: { view: RoomView }) {
  const me = view.seats.find((s) => s.seat === view.me.seat)!;
  return (
    <div className="panel">
      <h2>あなた：{me.name}</h2>
      {view.me.isCulprit && (
        <p className="error">
          <strong>あなたが犯人です。</strong>正体を隠し通してください。
        </p>
      )}
      <h3>状況</h3>
      <p className="prose">{view.me.situationText}</p>
      <h3>手札</h3>
      <div style={{ display: 'grid', gap: 8 }}>
        {view.me.cards.map((c) => (
          <div key={c.id} className={`card ${c.revealed ? 'revealed' : ''}`}>
            <h4>
              {c.title}
              {c.revealed && <span className="badge">公開済み</span>}
            </h4>
            <div className="prose">{c.body}</div>
          </div>
        ))}
      </div>
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
  return (
    <div className="panel">
      <h2>公開されたカード</h2>
      {view.revealed.length === 0 && <p className="muted">まだ公開されていません。</p>}
      <div style={{ display: 'grid', gap: 8 }}>
        {view.revealed.map((r) => (
          <div key={r.card.id} className="card">
            <h4>
              {r.card.title}
              <span className="badge">
                第{r.setNo}セット・{nameOf(r.seat)}
              </span>
            </h4>
            <div className="prose">{r.card.body}</div>
          </div>
        ))}
      </div>
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
        <div className="panel">
          <h2>事件の発端</h2>
          <p className="prose">{view.introText}</p>
          <ReadyButton socket={socket} view={view} label="読み終えた" disabled={disabled} />
        </div>
      );
    case 'CONFIRM':
      return (
        <div className="panel">
          <h2>キャラクターの確認</h2>
          <p>
            左の「あなた」の欄で、自分の状況と手札を確認してください。右の欄には登場人物と、あなた以外の人が見られる設定が並んでいます。
          </p>
          <ReadyButton socket={socket} view={view} label="準備完了" disabled={disabled} />
        </div>
      );
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
        全員が選ぶか時間切れになると、4枚が同時に公開されます。公開したカードの内容は、全員にとっての事実になります。
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
              <h4>{c.title}</h4>
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
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  return (
    <div className="chat">
      {messages.length === 0 && <p className="muted">{empty}</p>}
      {messages.map((m) => (
        <p key={m.id}>
          <span className="who">{nameOf(m.seat)}</span>
          {m.body}
        </p>
      ))}
      <div ref={bottom} />
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
                    {c.title}
                    {!c.revealed && <span className="badge npc">未公開</span>}
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
