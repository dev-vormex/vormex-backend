import type { AgentUiIntent } from './types';

export function normalizeAgentSurface(surface?: string | null): string {
  const normalized = String(surface || 'global').trim().toLowerCase();
  switch (normalized) {
    case 'home':
      return 'feed';
    case 'find':
    case 'network':
      return 'find_people';
    case 'growth':
      return 'growth_hub';
    case 'group':
      return 'groups';
    default:
      return normalized || 'global';
  }
}

export function resolveAgentSurfaceFromUiIntents(
  initialSurface?: string | null,
  uiIntents: AgentUiIntent[] = []
): string {
  let resolved = normalizeAgentSurface(initialSurface);

  for (const intent of uiIntents) {
    switch (intent.type) {
      case 'switch_tab':
        resolved = normalizeAgentSurface(intent.tab);
        break;
      case 'open_profile':
        resolved = 'profile';
        break;
      case 'open_chat':
        resolved = 'chat';
        break;
      case 'open_group':
      case 'open_groups':
        resolved = 'groups';
        break;
      case 'open_notifications':
        resolved = 'notifications';
        break;
      case 'open_growth_task':
        resolved = 'growth_hub';
        break;
      case 'show_match_stack':
        resolved = 'find_people';
        break;
      default:
        break;
    }
  }

  return resolved;
}

export function describeNavigationPreview(uiIntents: AgentUiIntent[] = []): string | null {
  const latestIntent = uiIntents.at(-1);
  if (!latestIntent) {
    return null;
  }

  switch (latestIntent.type) {
    case 'switch_tab': {
      const tab = normalizeAgentSurface(latestIntent.tab);
      switch (tab) {
        case 'feed':
          return 'Switching to Home';
        case 'find_people':
          return 'Opening Find People';
        case 'groups':
          return 'Opening Groups';
        case 'profile':
          return 'Opening Profile';
        case 'growth_hub':
          return 'Opening Growth Hub';
        default:
          return 'Switching pages';
      }
    }
    case 'open_profile':
      return 'Opening Profile';
    case 'open_chat':
      return 'Opening Chat';
    case 'open_group':
    case 'open_groups':
      return 'Opening Groups';
    case 'open_notifications':
      return 'Opening Notifications';
    case 'open_growth_task':
      return 'Opening Growth Hub';
    case 'show_match_stack':
      return 'Showing Matches';
    default:
      return 'Navigating in Vormex';
  }
}
