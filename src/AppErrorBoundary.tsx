import { Component, ErrorInfo, ReactNode } from "react";
import "./AppErrorBoundary.css";
import { LuZap } from "react-icons/lu";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[nyx.loader Recovery Guard] Startup error caught:", error, errorInfo);
  }

  handleLaunchSimpleMode = () => {
    try {
      localStorage.setItem("nyx_pref_simpleMode", "true");
    } catch {}
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="recovery-screen">
          <div className="recovery-card">
            <div className="recovery-icon">
              <LuZap size={34} color="#38bdf8" />
            </div>
            <h1 className="recovery-title">Сбой при запуске nyx.loader</h1>
            <p className="recovery-desc">
              Приложению не удалось корректно загрузить интерфейс в стандартном режиме.
              Это может произойти на старых компьютерах при нехватке видеопамяти или несовместимости графических эффектов.
            </p>
            <div className="recovery-actions">
              <button
                type="button"
                className="recovery-btn primary"
                onClick={this.handleLaunchSimpleMode}
              >
                <LuZap size={15} style={{ marginRight: 6 }} /> Запустить в Simple Mode (для слабых ПК)
              </button>
              <button
                type="button"
                className="recovery-btn secondary"
                onClick={this.handleRetry}
              >
                Повторить обычный запуск
              </button>
            </div>
            {this.state.error && (
              <details className="recovery-details">
                <summary>Технические подробности ошибки</summary>
                <pre>{this.state.error.stack || this.state.error.message}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
