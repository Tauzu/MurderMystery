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
    '- 各キャラクターは手札を4枚持つが、本人には見えない。手札の内容は状況文に書かれており、他の人に指名されると、その中のランダムな1枚が公開される。',
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
  const lines = [
    `■ あなたのキャラクター：${me.name}`,
    `公開プロフィール：${me.publicProfile}`,
    `状況（あなただけが知っている）：${view.me.situationText}`,
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
      `あなたの手札にある〈${kindLabel(f.card)}〉「${f.card.title}」：${f.card.body}`,
      'これはあなたが作った嘘です。公開されるかどうかは、他の人の指名で決まります。' +
        (view.revealed.some((r) => r.card.id === f.card.id)
          ? '（公開済み）'
          : '（まだ公開されていません）'),
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
    const by = view.seats[r.by]!.name;
    return `- 第${r.setNo}回 ${by}の指名で、${who}の手札から公開〈${kindLabel(r.card)}〉「${r.card.title}」：${r.card.body}`;
  });
  return ['■ 公開済みカード（全員が見ている。16枚のうち1枚だけ捏造カードがある）', ...lines].join(
    '\n',
  );
}

/** 前の回の会話。セットが進むまで変わらないので、キャッシュの対象にできる。 */
function pastChatBlock(view: RoomView): string {
  const name = (seat: number) => view.seats[seat]!.name;
  const line = (m: RoomView['chat'][number]) =>
    `${name(m.seat)}${m.seat === view.me.seat ? '（あなた）' : ''}：${m.body}`;
  const past = view.chat
    .filter((m) => m.scope === 'pair' && m.setNo < view.setNo)
    .slice(-CONFIG.NPC_HISTORY_COUNT);
  if (past.length === 0) return '';
  return [
    '■ 前の回の会話（別の相手との会話。古い順）',
    ...past.map(
      (m) => `[第${m.setNo}回・${name(partnerOf(view.me.seat, m.setNo))}との会話] ${line(m)}`,
    ),
  ].join('\n');
}

function currentChatBlock(view: RoomView): string {
  const name = (seat: number) => view.seats[seat]!.name;
  const line = (m: RoomView['chat'][number]) =>
    `${name(m.seat)}${m.seat === view.me.seat ? '（あなた）' : ''}：${m.body}`;
  const current = view.chat
    .filter((m) => m.scope === 'pair' && m.setNo === view.setNo)
    .slice(-CONFIG.NPC_HISTORY_COUNT);
  const partner = name(partnerOf(view.me.seat, view.setNo));
  return current.length === 0
    ? `■ ${partner}との会話\n（まだ発言はありません）`
    : [`■ ${partner}との会話（古い順）`, ...current.map(line)].join('\n');
}

/**
 * プロンプトのうち、ゲームを通して変わらない前半（導入、被害者、自キャラ、捏造カード、他の参加者）。
 * プロンプトキャッシュの対象にするため、会話のたびに変わる部分より前に置き、末尾の区切りまで含める。
 */
export function stablePrompt(view: RoomView): string {
  const blocks = [
    `■ 導入\n${view.introText}`,
    victimBlock(view),
    characterBlock(view),
    fabricatedBlock(view),
    othersBlock(view),
  ].filter((block) => block !== '');
  return blocks.join('\n\n') + '\n\n';
}

/**
 * 公開済みカードと前の回の会話。次のセットに進むまで変わらないので、stablePrompt の次のキャッシュ区切りにする。
 */
export function setPrompt(view: RoomView): string {
  return [revealedBlock(view), pastChatBlock(view)].filter((b) => b !== '').join('\n\n') + '\n\n';
}

/** シナリオと自キャラの共通部分。 */
function context(view: RoomView): string {
  return stablePrompt(view) + setPrompt(view) + currentChatBlock(view);
}

export function talkPrompt(view: RoomView, avoidRepeat = false): string {
  const name = (seat: number) => view.seats[seat]!.name;
  const me = name(view.me.seat);
  const last = view.chat.filter((m) => m.scope === 'pair' && m.setNo === view.setNo).at(-1);
  const notes: string[] = [];
  if (last?.seat === view.me.seat) {
    notes.push(
      'あなたの直前の発言に、相手はまだ返事をしていません。相手が答えた、あるいは同意・反論したかのように書かないこと（「本当にそうでしょうか」のような返事への返しは禁止）。同じ質問を言い換えて繰り返さず、まだ出していない別の事実・疑問を、独り言のように短く付け足すだけにしてください。',
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
  const options = view.pickableSeats.map((seat) => {
    const left = 4 - view.revealed.filter((r) => r.seat === seat).length;
    return `席${seat}=${view.seats[seat]!.name}（未公開の手札 ${left}枚）`;
  });
  const hint = view.me.isCulprit
    ? '犯人であるあなたは、疑いが自分に向かないように指名してください。捏造カードの持ち主を指名すれば、捏造カードが公開される可能性があります。'
    : '犯人だと疑う人や、まだ情報が少ない人を指名すると、事件の解明に役立ちます。';
  return [
    context(view),
    `■ 今回の指示\n手札を公開させる相手を、自分以外から1人指名します（第${view.setNo}回）。指名された人の未公開の手札から、ランダムに1枚が全員に公開されます。${hint}`,
    `指名できる人：${options.join('、')}`,
    '出力形式：JSONのみ。例 {"target": 席の番号}',
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
