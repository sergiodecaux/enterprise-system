import { useTranslation } from 'react-i18next'
import { useState, useEffect } from 'react'
import i18n from '../../i18n'

const LanguageToggle = () => {
  const { i18n: i18nInstance } = useTranslation()
  const [currentLang, setCurrentLang] = useState(i18nInstance.language)

  useEffect(() => {
    const handleLanguageChange = (lng: string) => {
      setCurrentLang(lng)
    }

    i18nInstance.on('languageChanged', handleLanguageChange)

    return () => {
      i18nInstance.off('languageChanged', handleLanguageChange)
    }
  }, [i18nInstance])

  const changeLanguage = (lang: 'en' | 'ru') => {
    i18n.changeLanguage(lang)
    localStorage.setItem('i18nextLng', lang)
  }

  return (
    <div className="flex items-center gap-1 bg-hull border border-hull-border rounded-full p-0.5">
      <button
        onClick={() => changeLanguage('en')}
        className={`px-3 py-1 rounded-full text-xs font-mono uppercase transition-all duration-300 ease-in-out ${
          currentLang === 'en'
            ? 'bg-matrix/20 text-matrix border border-matrix/50 neon-glow'
            : 'text-holo/50 hover:text-holo/80'
        }`}
      >
        EN
      </button>
      <button
        onClick={() => changeLanguage('ru')}
        className={`px-3 py-1 rounded-full text-xs font-mono uppercase transition-all duration-300 ease-in-out ${
          currentLang === 'ru'
            ? 'bg-matrix/20 text-matrix border border-matrix/50 neon-glow'
            : 'text-holo/50 hover:text-holo/80'
        }`}
      >
        RU
      </button>
    </div>
  )
}

export default LanguageToggle
