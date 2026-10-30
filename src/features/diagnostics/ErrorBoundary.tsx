import { Component, type ErrorInfo, type ReactNode } from 'react';

import { defaultErrorReporter, type ErrorReportingController } from './error-reporting';

export interface DiagnosticsErrorBoundaryProps {
  children: ReactNode;
  componentName?: string;
  reporter?: Pick<ErrorReportingController, 'report'>;
}

interface DiagnosticsErrorBoundaryState {
  hasError: boolean;
}

export class DiagnosticsErrorBoundary extends Component<
  DiagnosticsErrorBoundaryProps,
  DiagnosticsErrorBoundaryState
> {
  public state: DiagnosticsErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): DiagnosticsErrorBoundaryState {
    return { hasError: true };
  }

  public componentDidCatch(_error: Error, _info: ErrorInfo): void {
    const reporter = this.props.reporter ?? defaultErrorReporter;
    const rawComponent = this.props.componentName ?? 'renderer/root-boundary';
    void reporter.report({
      category: 'renderer',
      severity: 'error',
      code: 'RENDERER_BOUNDARY_ERROR',
      component: rawComponent,
      process: 'renderer',
    });
  }

  private readonly handleReset = (): void => {
    this.setState({ hasError: false });
  };

  public render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <section className="office-approval-gate" role="alert" aria-labelledby="dks-boundary-title">
        <div className="office-approval-card">
          <h1 id="dks-boundary-title" className="office-approval-card__title">
            Something went wrong in this view
          </h1>
          <p className="office-approval-card__body">
            Your saved records remain intact. Try returning to the workspace view, or restart DKS if the problem repeats.
          </p>
          <div className="office-approval-card__actions">
            <button type="button" className="button button--primary" onClick={this.handleReset}>
              Try again
            </button>
          </div>
        </div>
      </section>
    );
  }
}
