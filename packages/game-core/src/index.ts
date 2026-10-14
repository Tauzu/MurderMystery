// ルーム状態機械。副作用を持たない純粋関数のみを置く。設計書 §6。
export * from './types';
export * from './create';
export { reduce, characterOf, partnerOf } from './reduce';
export * from './view';
export * from './protocol';
