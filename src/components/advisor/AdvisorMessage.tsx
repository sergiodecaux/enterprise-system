import type { ReactNode } from 'react'
import type { AdvisorUiMessage } from '../../store/useAdvisorStore'

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={i} className="text-holo">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    )
  )
}

function renderBody(content: string): ReactNode[] {
  return content.split('\n').map((line, i) => {
    const heading = line.match(/^#{1,4}\s+(.*)$/)
    if (heading) {
      return (
        <div key={i} className="mt-1.5 font-bold text-matrix">
          {inline(heading[1])}
        </div>
      )
    }
    if (!line.trim()) return <div key={i} className="h-1.5" />
    return <div key={i}>{inline(line.replace(/^\s*[-*]\s+/, '• '))}</div>
  })
}

const AdvisorMessage = ({ message }: { message: AdvisorUiMessage }) => {
  const isUser = message.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[90%] rounded-xl px-3 py-2 font-mono text-[12px] leading-relaxed ${
          isUser
            ? 'border border-matrix/30 bg-matrix/10 text-holo'
            : 'border border-hull-border bg-hull-light/60 text-holo/90'
        }`}
      >
        {message.content ? (
          <div className="break-words">{renderBody(message.content)}</div>
        ) : message.pending ? (
          <span className="animate-pulse text-holo/50">Советник думает…</span>
        ) : null}
        {message.error && (
          <div className="mt-1 text-[11px] text-alert">{message.error}</div>
        )}
        {!isUser && !message.pending && (message.model || message.node) && (
          <div className="mt-1 text-[9px] uppercase text-holo/30">
            {message.node ? `узел ${message.node} · ` : ''}
            {message.model?.split('/').pop()}
          </div>
        )}
      </div>
    </div>
  )
}

export default AdvisorMessage
