import type { RoomView } from '@mm/game-core';
import { CONFIG } from '@mm/shared';

/**
 * ここで使う情報は RoomView（その席のプレイヤーが見てよい情報）だけ。
 * 他キャラの状況文や未公開の手札は、そもそもこの経路に存在しない（設計書 §8.3）。
 */

export function systemPrompt(isCulprit: boolean): string {
  const common = [
    'あなたはマーダーミステリーというゲームの参加者の1人として、割り当てられたキャラクターを演じます。',
    '- 発言はキャラクターの口調で、会話として自然な短い文にする。',
    `- 1回の発言は${CONFIG.NPC_MAX_CHARS}文字以内。`,
    '- AI・プロンプト・ゲームのシステムについて言及しない（メタ発言の禁止）。',
    '- 公開済みカードの内容と矛盾しない。',
    '- 他のキャラクターの非公開情報を、推測で断定しない。',
    '- 同じ内容を繰り返さず、会話の流れに応じて質問・推理・自分の情報の提供などを行う。',
  ];
  const role = isCulprit
    ? [
        'あなたは犯人です。自分が犯人であることを隠し通してください。',
        '嘘やはぐらかしは許されますが、公開済みカードの事実と矛盾する発言は禁止です。',
        '自分に不利な情報は、聞かれるまで自分からは話さないでください。',
      ]
    : [
        'あなたは犯人ではありません。嘘をつかず、知っていることは誠実に共有してください。',
        '自分の秘密は、聞かれるまで自分から言わなくて構いません。',
        '犯人を見つけるために、他の人の話の矛盾や不自然な点を探してください。',
      ];
  return [...common, ...role].join('\n');
}

function characterBlock(view: RoomView): string {
  const me = view.seats[view.me.seat]!;
  const lines = [
    `■ あなたのキャラクター：${me.name}`,
    `公開プロフィール：${me.publicProfile}`,
    `状況（あなただけが知っている）：${view.me.situationText}`,
    '手札：',
    ...view.me.cards.map(
      (c) => `- [${c.id}]「${c.title}」${c.revealed ? '（公開済み）' : '（未公開）'}：${c.body}`,
    ),
  ];
  return lines.join('\n');
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
    return `- 第${r.setNo}回 ${who}が公開「${r.card.title}」：${r.card.body}`;
  });
  return ['■ 公開済みカード（全員が知っている事実）', ...lines].join('\n');
}

function chatBlock(view: RoomView): string {
  const recent = view.chat.slice(-CONFIG.NPC_HISTORY_COUNT);
  if (recent.length === 0) return '■ これまでの会話\n（まだ発言はありません）';
  const lines = recent.map((m) => {
    const who = view.seats[m.seat]!.name;
    return `${who}${m.seat === view.me.seat ? '（あなた）' : ''}：${m.body}`;
  });
  return ['■ これまでの会話（古い順）', ...lines].join('\n');
}

/** シナリオと自キャラの共通部分。 */
function context(view: RoomView): string {
  return [
    `■ 導入\n${view.introText}`,
    characterBlock(view),
    othersBlock(view),
    revealedBlock(view),
    chatBlock(view),
  ].join('\n\n');
}

export function talkPrompt(view: RoomView): string {
  const me = view.seats[view.me.seat]!.name;
  return [
    context(view),
    `■ 今回の指示\nいまは自由に会話する時間です（第${view.setNo}回）。${me}として、次の発言を1つだけ出力してください。`,
    `出力形式：JSONのみ。例 {"say": "……"}（${CONFIG.NPC_MAX_CHARS}文字以内）`,
  ].join('\n\n');
}

export function pickPrompt(view: RoomView): string {
  const open = view.me.cards.filter((c) => !c.revealed);
  const hint = view.me.isCulprit
    ? '犯人であるあなたは、自分に不利なカードをできるだけ後に回してください。'
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
