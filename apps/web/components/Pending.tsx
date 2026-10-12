/** 読み込み中の表示。取得に失敗していたら、止まったままにせず理由と再読み込みを出す。 */
export function Pending({ error }: { error?: string | null }) {
  if (!error) return <p className="muted">読み込み中…</p>;
  return (
    <div className="panel">
      <p className="error">{error}</p>
      <button onClick={() => window.location.reload()}>再読み込み</button>
    </div>
  );
}
