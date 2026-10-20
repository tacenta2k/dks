interface LoginPlaceholderProps {
  onContinue?: () => void;
}

export function LoginPlaceholder({ onContinue = () => undefined }: LoginPlaceholderProps) {
  return (
    <main className="login-page" aria-labelledby="login-title">
      <section className="login-card">
        <div className="brand-mark brand-mark--large" aria-hidden="true">
          <span>D</span>
        </div>
        <p className="eyebrow">DKS workspace</p>
        <h1 id="login-title">Sign in to DKS</h1>
        <p className="login-card__description">
          Keep visa and medical records organized in one calm, focused workspace.
        </p>
        <div className="placeholder-callout" role="status">
          <span className="placeholder-callout__dot" aria-hidden="true" />
          <span>Authentication will be connected in STEP 2.</span>
        </div>
        <button className="button button--primary button--wide" type="button" onClick={onContinue}>
          Continue to workspace
          <span aria-hidden="true">→</span>
        </button>
        <p className="login-card__footnote">Preview the STEP 1 shell while sign-in is being prepared.</p>
      </section>
      <footer className="login-page__footer">DKS · Designed for dependable office workflows</footer>
    </main>
  );
}
