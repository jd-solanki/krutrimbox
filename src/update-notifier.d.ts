declare module "update-notifier" {
  interface Package {
    name: string;
    version: string;
  }
  interface Options {
    pkg: Package;
    updateCheckInterval?: number;
    distTag?: string;
  }
  interface NotifyOptions {
    defer?: boolean;
    message?: string;
    isGlobal?: boolean;
  }
  interface Notifier {
    notify(options?: NotifyOptions): void;
  }
  export default function updateNotifier(options: Options): Notifier;
}
