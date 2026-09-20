export const DEFAULT_JEV_MODEL = "jev-1.13.0";

export const SEMANTIC_THRESHOLDS = Object.freeze({
	choice: 0.7,
	noul: 0.8,
	actionChoice: 0.9,
	actionReady: 0.95,
});

export const SEMANTIC_SAFE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
export const SEMANTIC_SAFE_ID = new RegExp(SEMANTIC_SAFE_ID_PATTERN);
