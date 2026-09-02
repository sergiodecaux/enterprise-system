import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.enterprisesystem.tactical',
  appName: 'Enterprise System',
  webDir: 'dist',
  backgroundColor: '#0a0a0a',
  android: {
    allowMixedContent: false,
    backgroundColor: '#0a0a0a',
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: true,
      backgroundColor: '#0a0a0a',
      showSpinner: false,
    },
  },
}

export default config
