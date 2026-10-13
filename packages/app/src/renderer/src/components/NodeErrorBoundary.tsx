import { Component, type ReactNode } from 'react';

export class NodeErrorBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    window.orquestra.reportError(`Nó ${this.props.name}: ${error.message}`, error.stack ?? '');
  }

  render() {
    if (this.state.failed) return <div className="term-failed">Este terminal falhou ao desenhar. Remova e crie de novo.</div>;
    return this.props.children;
  }
}
