import { stopClientObservation } from './observation.js';
import { launchWithTextInput, releaseTextInput } from './text-input.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';

export const appsTools: ToolDefinition[] = [
  {
    definition: {
      name: 'list_apps',
      description: 'List installed apps on the selected device, including bundleId, name, installType and processState. Defaults to user-installed apps, excluding system/unknown installation types. Set installType to all for every app or system for system apps only. Does not launch apps.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        installType: { type: 'string', enum: ['user', 'system', 'all'], default: 'user', description: 'Filter by backend installation type; all includes unknown types.' },
      } },
    },
    async execute(idbClient, args) {
      const installType = args.installType as 'user' | 'system' | 'all' | undefined ?? 'user';
      const apps = await idbClient.listApps();
      return { success: true, apps: installType === 'all' ? apps : apps.filter(app => app.installType?.toLowerCase() === installType) };
    },
  },
  {
    definition: {
      name: 'open_url',
      description: 'Open an absolute URL or deep link on the selected device. The app must support the URL scheme. Success means the open request was sent, not that the destination page is ready; use capture to inspect it.',
      inputSchema: { type: 'object', properties: {
        url: { type: 'string', format: 'uri', description: 'Absolute URL, e.g. https://example.com or myapp://page. Encode spaces.' },
      }, required: ['url'] },
    },
    async execute(idbClient, args) {
      await idbClient.openUrl(args.url as string);
      return { success: true, message: 'URL open request sent. Use capture to inspect the destination.' };
    },
  },
  {
    definition: {
      name: 'install_app',
      description: 'Install an app on the connected device',
      inputSchema: {
        type: 'object',
        properties: {
          appPath: {
            type: 'string',
            description: 'Path to .app bundle',
          },
        },
        required: ['appPath'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.installApp(args.appPath as string);
      return { success: true, message: 'App installed successfully' };
    },
  },
  {
    definition: {
      name: 'launch_app',
      description: 'Launch an app. enableTextInput:true explicitly restarts it with app-local Unicode/replace/clear support for standard UIKit/SwiftUI editors; does not start Observe. No clipboard or extra permissions. Default launch waits for Running (up to 10s); UI readiness is not guaranteed.',
      inputSchema: {
        type: 'object',
        properties: {
          enableTextInput: { type: 'boolean', default: false, description: 'Restart app with native text input enabled.' },
          bundleId: {
            type: 'string',
            description: 'App bundle ID (e.g., com.example.app)',
          },
        },
        required: ['bundleId'],
      },
    },
    async execute(idbClient, args) {
      if (args.enableTextInput) {
        await stopClientObservation(idbClient);
        return launchWithTextInput(idbClient, args.bundleId as string);
      }
      releaseTextInput(idbClient);
      await idbClient.launchApp(args.bundleId as string);
      return { success: true, message: `App ${args.bundleId} launched` };
    },
  },
  {
    definition: {
      name: 'terminate_app',
      description: 'Request app termination. An uninstalled bundle ID is an error; an already stopped app is a no-op. confirmed:false with terminated:null means the backend accepted termination but did not report a reliable stopped state.',
      inputSchema: {
        type: 'object',
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle ID',
          },
        },
        required: ['bundleId'],
      },
    },
    async execute(idbClient, args) {
      await stopClientObservation(idbClient, args.bundleId as string);
      const state = await idbClient.terminateApp(args.bundleId as string);
      releaseTextInput(idbClient, args.bundleId as string);
      return { success: true, ...state, message: state?.alreadyStopped ? `App ${args.bundleId} was already stopped` : state?.confirmed === false ? `Termination requested for ${args.bundleId}; backend process state is unconfirmed` : `App ${args.bundleId} terminated` };
    },
  },
  {
    definition: {
      name: 'uninstall_app',
      description: 'Uninstall an app from the device',
      inputSchema: {
        type: 'object',
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle ID',
          },
        },
        required: ['bundleId'],
      },
    },
    async execute(idbClient, args) {
      await stopClientObservation(idbClient, args.bundleId as string);
      await idbClient.uninstallApp(args.bundleId as string);
      releaseTextInput(idbClient, args.bundleId as string);
      return { success: true, message: `App ${args.bundleId} uninstalled` };
    },
  },
];
