import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/1.2.3"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]),
  },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../preview/WebviewPreferences.ts";

const PLANTED_WEBPREFERENCES = "nodeIntegration=yes";
const VALID_PARTITION = "persist:t3code-preview-lab";
const INVALID_PARTITION = "persist:attacker-partition";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/tmp/t3-lab-home",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

type AttachPrefs = Electron.WebPreferences & { webpreferences?: string };

function makeFakeBrowserWindow() {
  const webContentsListeners = new Map<string, (...args: readonly unknown[]) => void>();
  let zoomLevel = 0;
  const webContents = {
    copyImageAt: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => "t3code-dev://app/"),
    getZoomLevel: vi.fn(() => zoomLevel),
    getZoomFactor: vi.fn(() => 1.2 ** zoomLevel),
    setZoomLevel: vi.fn((level: number) => {
      zoomLevel = level;
    }),
    isLoadingMainFrame: vi.fn(() => false),
    navigationHistory: {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => true),
      goBack: vi.fn(),
      goForward: vi.fn(),
    },
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsListeners.set(eventName, listener);
    }),
    once: vi.fn<(eventName: string, listener: (...args: readonly unknown[]) => void) => void>(),
    openDevTools: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    replaceMisspelling: vi.fn(),
    send: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    toggleDevTools: vi.fn(),
  };

  const window = {
    close: vi.fn(),
    focus: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    loadURL: vi.fn(() => Promise.resolve()),
    maximize: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    restore: vi.fn(),
    setBackgroundColor: vi.fn(),
    setAutoHideCursor: vi.fn(),
    setFullScreen: vi.fn(),
    setOpacity: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    show: vi.fn(),
    webContents,
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    webContentsListeners,
  };
}

const layerDesktopClientSettings = Layer.mock(DesktopClientSettings.DesktopClientSettings)({
  get: Effect.succeedNone,
});

const layerElectronApp = Layer.mock(ElectronApp.ElectronApp)({
  quit: Effect.void,
});

const layerDesktopAssets = Layer.succeed(DesktopAssets.DesktopAssets, {
  iconPaths: Effect.succeed({
    ico: Option.none<string>(),
    icns: Option.none<string>(),
    png: Option.none<string>(),
  }),
  resolveResourcePath: () => Effect.succeed(Option.none<string>()),
} satisfies DesktopAssets.DesktopAssets["Service"]);

const layerDesktopServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.die("unexpected getAdvertisedEndpoints"),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

const layerDesktopEnvironment = DesktopEnvironment.layer(environmentInput).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      DesktopConfig.layerTest({
        T3CODE_PORT: "3773",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
      }),
    ),
  ),
);

function layerTest(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
}) {
  const layerDesktopAppSettings = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    get: Effect.sync(() => DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
    load: Effect.sync(() => DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
    setMainWindowBounds: () => Effect.die("unexpected bounds persist"),
    setServerExposureMode: () => Effect.die("unexpected server exposure update"),
    setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
    setUpdateChannel: () => Effect.die("unexpected update channel change"),
    setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
    setWslDistro: () => Effect.die("unexpected WSL distro change"),
    setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
    setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
    applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
    applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
  } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

  const layerElectronWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () =>
      Ref.update(input.createCount, (count) => count + 1).pipe(Effect.as(input.window)),
    main: Ref.get(input.mainWindow),
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst: Ref.get(input.mainWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: (sync) => sync(input.window),
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  return DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDesktopAssets,
        Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
          register: () => Effect.void,
          recordMetrics: () => Effect.void,
          shutdown: Effect.void,
        }),
        layerDesktopEnvironment,
        layerDesktopAppSettings,
        layerDesktopClientSettings,
        layerDesktopServerExposure,
        DesktopState.layer,
        layerElectronApp,
        Layer.succeed(ElectronMenu.ElectronMenu, {
          setApplicationMenu: () => Effect.void,
          showContextMenu: () => Effect.succeedNone,
          popupTemplate: () => Effect.void,
        }),
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: () => Effect.succeed(true),
          openSystemSettings: () => Effect.succeed(true),
          copyText: () => Effect.void,
        } satisfies ElectronShell.ElectronShell["Service"]),
        layerElectronTheme,
        layerElectronWindow,
        Layer.mock(PreviewPasskeys.PreviewPasskeys)({
          bridgeEnabled: false,
          installSessionHandlers: () => {},
          attachGuest: () => () => {},
        }),
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession: () => Effect.succeed({} as Electron.Session),
          setMainWindow: () => Effect.void,
          prepareWebview: () => Effect.void,
          isBrowserPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
          getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"),
          reapplyZoom: () => Effect.void,
        }),
      ),
    ),
    Layer.merge(DesktopState.layer),
  );
}

type LabResult = {
  contextIsolation: boolean | "missing";
  sandbox: boolean | "missing";
  nodeIntegration: boolean | "missing";
  preloadKept: 0 | 1;
  webpreferencesKept: 0 | 1;
  preventDefaultInvalidPartition: 0 | 1;
  preventDefaultValidPartition: 0 | 1;
  previewPrefsIsolationOff: 0 | 1;
  previewPrefs: string;
  preloadAfter: string;
  webpreferencesAfter: string;
  handlerInvoked: 0 | 1;
};

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

describe("T3-F03-WEBVIEW", () => {
  it.effect("keeps page-supplied preload and webpreferences on preview will-attach-webview", () =>
    Effect.gen(function* () {
      const preloadPath = requiredEnv("LAB_PRELOAD_PATH");
      const witness = requiredEnv("LAB_WITNESS");
      const resultPath = requiredEnv("LAB_RESULT_PATH");
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      const result: LabResult = {
        contextIsolation: "missing",
        sandbox: "missing",
        nodeIntegration: "missing",
        preloadKept: 0,
        webpreferencesKept: 0,
        preventDefaultInvalidPartition: 0,
        preventDefaultValidPartition: 0,
        previewPrefsIsolationOff: PREVIEW_WEBVIEW_PREFERENCES.includes("contextIsolation=false")
          ? 1
          : 0,
        previewPrefs: PREVIEW_WEBVIEW_PREFERENCES,
        preloadAfter: "",
        webpreferencesAfter: "",
        handlerInvoked: 0,
      };

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        const attach = fakeWindow.webContentsListeners.get("will-attach-webview");
        if (!attach) {
          return yield* Effect.die("will-attach-webview listener was not registered");
        }
        result.handlerInvoked = 1;

        const webPreferences: AttachPrefs = {
          preload: preloadPath,
          webpreferences: PLANTED_WEBPREFERENCES,
          sandbox: false,
          nodeIntegration: true,
          nodeIntegrationInSubFrames: true,
          contextIsolation: true,
        };
        const validPreventDefault = vi.fn();
        attach({ preventDefault: validPreventDefault }, webPreferences, {
          partition: VALID_PARTITION,
          src: "https://example.invalid/",
        });
        result.preventDefaultValidPartition = validPreventDefault.mock.calls.length > 0 ? 1 : 0;
        result.contextIsolation =
          typeof webPreferences.contextIsolation === "boolean"
            ? webPreferences.contextIsolation
            : "missing";
        result.sandbox =
          typeof webPreferences.sandbox === "boolean" ? webPreferences.sandbox : "missing";
        result.nodeIntegration =
          typeof webPreferences.nodeIntegration === "boolean"
            ? webPreferences.nodeIntegration
            : "missing";
        result.preloadAfter = String(webPreferences.preload ?? "");
        result.webpreferencesAfter = String(webPreferences.webpreferences ?? "");
        result.preloadKept =
          Object.hasOwn(webPreferences, "preload") && result.preloadAfter.includes(witness) ? 1 : 0;
        result.webpreferencesKept =
          Object.hasOwn(webPreferences, "webpreferences") &&
          result.webpreferencesAfter === PLANTED_WEBPREFERENCES
            ? 1
            : 0;

        const invalidPreventDefault = vi.fn();
        attach({ preventDefault: invalidPreventDefault }, {}, { partition: INVALID_PARTITION });
        result.preventDefaultInvalidPartition =
          invalidPreventDefault.mock.calls.length > 0 ? 1 : 0;
      }).pipe(Effect.provide(layer));

      NodeFS.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
      assert.equal(result.handlerInvoked, 1);
      assert.equal(result.contextIsolation, false);
      assert.equal(result.sandbox, true);
      assert.equal(result.nodeIntegration, false);
      assert.equal(result.preloadKept, 1);
      assert.equal(result.webpreferencesKept, 1);
      assert.equal(result.preventDefaultInvalidPartition, 1);
      assert.equal(result.preventDefaultValidPartition, 0);
      assert.equal(result.previewPrefsIsolationOff, 1);
    }),
  );
});
