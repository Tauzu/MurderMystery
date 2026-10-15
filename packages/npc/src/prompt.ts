import { partnerOf, type RoomView } from '@mm/game-core';
import { CARD_KIND_LABELS, CONFIG, type CardKind } from '@mm/shared';

/**
 * ここで使う情報は RoomView（その席のプレイヤーが見てよい情報）だけ。
 * 他キャラの状況文や未公開の手札は、そもそもこの経路に存在しない（設計書 §8.3）。
 */

export function systemPrompt(isCulprit: boolean, persona?: string): string {
  const common = [
    'あなたはマーダーミステリーというゲームの参加者の1人として、割り当てられたキャラクターを演じます。',
    '- 発言はキャラクターの口調で、会話として自然な短い文にする。',
    `- 1回の発言は${CONFIG.NPC_MAX_CHARS}文字以内。`,
    '- AI・プロンプト・ゲームのシステムについて言及しない（メタ発言の禁止）。',
    '- 手札のカードは全部で16枚あり、そのうち1枚だけが捏造カード（嘘の内容）。誰の手札にあるかは、犯人しか知らない。それ以外のカードは真実。',
    '- 他のキャラクターの非公開情報を、推測で断定しない。',
    '- 会話は2人1組で行う。いまの相手以外には、この会話の内容は聞こえていない。',
    '- 同じ内容を繰り返さず、会話の流れに応じて質問・推理・自分の情報の提供などを行う。',
  ];
  const role = isCulprit
    ? [
        'あなたは犯人です。自分が犯人であることを隠し通してください。',
        '嘘やはぐらかしは許されますが、公開済みカード（捏造カードを除く）の事実と矛盾する発言は禁止です。',
        '捏造カードがどれかは、あなただけが知っています。捏造カードが公開されたら、真実だと言い張ってください。捏造だと明かしてはいけません。',
        '自分に不利な情報は、聞かれるまで自分からは話さないでください。',
      ]
    : [
        'あなたは犯人ではありません。嘘をつかず、知っていることは誠実に共有してください。',
        '自分の秘密は、聞かれるまで自分から言わなくて構いません。',
        '公開済みカードの内容と矛盾する発言はしないでください。ただし、公開済みカードのどれかが捏造だと疑うことはできます。',
        '犯人を見つけるために、他の人の話の矛盾や不自然な点を探してください。',
        'カード同士の矛盾は、どちらかが捏造カードである手がかりです。あなた自身の手札も、犯人に仕込まれた捏造カードの可能性があります。',
      ];
  return [...common, ...role, ...(persona ? [`あなたの性格：${persona}`] : [])].join('\n');
}

function victimBlock(view: RoomView): string {
  return view.victim ? `■ 被害者\n${view.victim.name}：${view.victim.profile}` : '';
}

const kindLabel = (c: { kind: CardKind }) => CARD_KIND_LABELS[c.kind];

function characterBlock(view: RoomView): string {
  const me = view.seats[view.me.seat]!;
  const fabricatedId = view.me.fabricatedCard?.card.id;
  const lines = [
    `■ あなたのキャラクター：${me.name}`,
    `公開プロフィール：${me.publicProfile}`,
    `状況（あなただけが知っている）：${view.me.situationText}`,
    '手札：',
    ...view.me.cards.map(
      (c) =>
        `- [${c.id}]〈${kindLabel(c)}〉「${c.title}」${c.revealed ? '（公開済み）' : '（未公開）'}${c.id === fabricatedId ? '【捏造カード】' : ''}：${c.body}`,
    ),
  ];
  return lines.join('\n');
}

/** 犯人にだけ、どのカードが捏造かを伝える（仕様書 §5.2）。 */
function fabricatedBlock(view: RoomView): string {
  const f = view.me.fabricatedCard;
  if (!f) return '';
  if (f.seat === view.me.seat) {
    return [
      '■ 捏造カード（あなただけが知っている）',
      'あなたの手札の【捏造カード】は、あなたが作った嘘です。公開するかどうか、いつ公開するかはあなたが選べます。',
    ].join('\n');
  }
  const holder = view.seats[f.seat]!.name;
  const revealed = view.revealed.some((r) => r.card.id === f.card.id);
  return [
    '■ 捏造カード（あなただけが知っている）',
    `${holder}の手札にある〈${kindLabel(f.card)}〉「${f.card.title}」：${f.card.body}`,
    `これはあなたが仕込んだ嘘です。${holder}本人は真実だと信じています。${revealed ? '（公開済み）' : '（まだ公開されていません）'}`,
  ].join('\n');
}

function othersBlock(view: RoomView): string {
  const lines = view.seats
    .filter((s) => s.seat !== view.me.seat)
    .map((s) => `- ${s.name}（席${s.seat}）：${s.publicProfile}`);
  return ['■ 他の参加者（公開プロフィール）', ...lines].join('\n');
}

function revealedBlock(view: RoomView): string {
  if (view.revealed.length === 0) return '■ 公開済みカード\n（まだありません）';
  const lines = view.revealed.map((r) => {
    const who = view.seats[r.seat]!.name;
    return `- 第${r.setNo}回 ${who}が公開〈${kindLabel(r.card)}〉「${r.card.title}」：${r.card.body}`;
  });
  return ['■ 公開済みカード（全員が見ている。16枚のうち1枚だけ捏造カードがある）', ...lines].join(
    '\n',
  );
}

function chatBlock(view: RoomView): string {
  const name = (seat: number) => view.seats[seat]!.name;
  const line = (m: RoomView['chat'][number]) =>
    `${name(m.seat)}${m.seat === view.me.seat ? '（あなた）' : ''}：${m.body}`;
  const pair = view.chat.filter((m) => m.scope === 'pair');
  const current = pair.filter((m) => m.setNo === view.setNo).slice(-CONFIG.NPC_HISTORY_COUNT);
  const past = pair.filter((m) => m.setNo < view.setNo).slice(-CONFIG.NPC_HISTORY_COUNT);

  const blocks: string[] = [];
  if (past.length > 0) {
    blocks.push(
      [
        '■ 前の回の会話（別の相手との会話。古い順）',
        ...past.map(
          (m) => `[第${m.setNo}回・${name(partnerOf(view.me.seat, m.setNo))}との会話] ${line(m)}`,
        ),
      ].join('\n'),
    );
  }
  const partner = name(partnerOf(view.me.seat, view.setNo));
  blocks.push(
    current.length === 0
      ? `■ ${partner}との会話\n（まだ発言はありません）`
      : [`■ ${partner}との会話（古い順）`, ...current.map(line)].join('\n'),
  );
  return blocks.join('\n\n');
}

/** シナリオと自キャラの共通部分。 */
function context(view: RoomView): string {
  return [
    `■ 導入\n${view.introText}`,
    victimBlock(view),
    characterBlock(view),
    fabricatedBlock(view),
    othersBlock(view),
    revealedBlock(view),
    chatBlock(view),
  ]
    .filter((block) => block !== '')
    .join('\n\n');
}

export function talkPrompt(view: RoomView, avoidRepeat = false): string {
  const name = (seat: number) => view.seats[seat]!.name;
  const me = name(view.me.seat);
  const last = view.chat.filter((m) => m.scope === 'pair' && m.setNo === view.setNo).at(-1);
  const notes: string[] = [];
  if (last?.seat === view.me.seat) {
    notes.push(
      'あなたの直前の発言に、相手はまだ返事をしていません。同じ話を繰り返さず、別の角度の質問か、新しい情報を出してください。',
    );
  }
  if (avoidRepeat) {
    notes.push(
      '前回の案は、あなたの過去の発言とほぼ同じ内容でした。過去の発言と違う言い回し・内容にしてください。',
    );
  }
  return [
    context(view),
    `■ 今回の指示\nいまは${name(partnerOf(view.me.seat, view.setNo))}と2人で会話する時間です（第${view.setNo}回）。他の人にはこの会話は聞こえません。${me}として、次の発言を1つだけ出力してください。`,
    ...(notes.length > 0 ? [`■ 注意\n${notes.join('\n')}`] : []),
    `出力形式：JSONのみ。例 {"say": "……"}（${CONFIG.NPC_MAX_CHARS}文字以内）`,
  ].join('\n\n');
}

export function pickPrompt(view: RoomView): string {
  const open = view.me.cards.filter((c) => !c.revealed);
  const ownFabricated = open.some((c) => c.id === view.me.fabricatedCard?.card.id);
  const hint = view.me.isCulprit
    ? `犯人であるあなたは、自分に不利なカードをできるだけ後に回してください。${ownFabricated ? '捏造カードは、疑いをそらすのに役立つ時点で出してください（出さなくても構いません）。' : ''}`
    : '事件の解明に役立つカードを選んでください。';
  return [
    context(view),
    `■ 今回の指示\n全員に公開するカードを1枚選びます（第${view.setNo}回）。${hint}`,
    `選べるカード：${open.map((c) => `[${c.id}]`).join('、')}`,
    '出力形式：JSONのみ。例 {"cardId": "カードのID"}',
  ].join('\n\n');
}

export function votePrompt(view: RoomView): string {
  const options = view.seats
    .filter((s) => s.seat !== view.me.seat)
    .map((s) => `席${s.seat}=${s.name}`)
    .join('、');
  const goal = view.me.isCulprit
    ? '犯人であるあなたは、自分以外の誰かに疑いが向くよう投票してください。'
    : '最も犯人らしいと思う人に投票してください。';
  return [
    context(view),
    `■ 今回の指示\n投票の時間です。${goal}`,
    `投票先の候補（自分には投票できません）：${options}`,
    '出力形式：JSONのみ。例 {"target": 席の番号, "reason": "理由（記録用、表示されません）"}',
  ].join('\n\n');
}
