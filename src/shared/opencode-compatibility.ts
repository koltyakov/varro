// Bump this only when Varro starts relying on APIs from a newer OpenCode release.
// Keeping it explicit avoids forcing a CLI update for SDK-only patch releases.
export const MINIMUM_SUPPORTED_OPENCODE_VERSION = '1.16.0';

// Highest release exercised by the compatibility probe before this build shipped.
// Background updates must not cross this boundary without a new probe result.
export const MAXIMUM_TESTED_OPENCODE_VERSION = '1.17.18';

export const OPENCODE_UPDATE_REQUIRED_PREFIX = 'OpenCode update required.';
