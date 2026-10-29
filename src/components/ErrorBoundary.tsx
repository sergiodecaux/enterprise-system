import { Component, ErrorInfo, ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import Button from './ui/Button'

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
    console.error('ErrorBoundary caught an error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-bg-base p-4">
          <div className="w-full max-w-md rounded-lg border border-market-short/25 bg-bg-panel p-5 text-center">
            <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-md border border-market-short/25 bg-market-short/10 text-market-short">
              <AlertTriangle className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <h1 className="mb-1.5 font-sans text-[15px] font-semibold leading-5 text-text-primary">
              Ошибка системы
            </h1>
            <p className="mb-4 break-words font-mono text-[11px] leading-4 text-text-muted">
              {this.state.error?.message || 'Произошла непредвиденная ошибка'}
            </p>
            <Button
              variant="primary"
              size="md"
              onClick={() => window.location.reload()}
            >
              Перезагрузить
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
