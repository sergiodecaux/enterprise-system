import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // ErrorBoundary errors should always be logged
    console.error('🔴 ErrorBoundary caught an error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-space flex items-center justify-center p-4">
          <div className="text-center max-w-md">
            <div className="text-4xl mb-4">⚠️</div>
            <h1 className="text-xl font-mono font-bold text-alert mb-2">
              ОШИБКА СИСТЕМЫ
            </h1>
            <p className="text-sm text-holo/60 font-mono mb-4">
              {this.state.error?.message || 'Произошла непредвиденная ошибка'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-matrix/20 text-matrix border border-matrix/50 rounded-lg font-mono text-sm hover:bg-matrix/30 transition-colors"
            >
              ПЕРЕЗАГРУЗИТЬ
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
