import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './styles/globals.css'
import './i18n'

// Loading spinner component
const LoadingSpinner = () => (
  <div className="flex items-center justify-center min-h-screen bg-space">
    <div className="flex flex-col items-center gap-4">
      <div className="w-12 h-12 border-4 border-matrix border-t-transparent rounded-full animate-spin"></div>
      <p className="text-holo font-mono text-sm">INITIALIZING SYSTEM...</p>
    </div>
  </div>
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={<LoadingSpinner />}>
      <App />
    </Suspense>
  </React.StrictMode>,
)
