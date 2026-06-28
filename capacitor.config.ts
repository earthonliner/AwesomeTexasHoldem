import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the built static app (dist/) into a native iOS shell so it can
 * be installed on an iPad and run fully offline (all assets are bundled in the
 * app — no server or network required, e.g. on a plane).
 *
 * Build flow on a Mac:
 *   npm run build            # produces dist/
 *   npx cap add ios          # first time only, scaffolds ios/
 *   npx cap sync ios         # copies dist/ into the native project
 *   npx cap open ios         # opens Xcode to run on your iPad
 */
const config: CapacitorConfig = {
  appId: 'com.texaspoker.trainer',
  appName: '德扑练习',
  webDir: 'dist',
  ios: {
    // Use a solid background to avoid a white flash on launch.
    backgroundColor: '#0b1220',
  },
};

export default config;
