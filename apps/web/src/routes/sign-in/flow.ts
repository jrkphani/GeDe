/**
 * Sign-in state machine (AUTH-02..06). Pure: the screen dispatches, effects
 * live in the component. Every transition is a named action so tests can
 * drive the machine without the network.
 */
export type Mode = 'sign-in' | 'sign-up';
export type Step = 'email' | 'method' | 'code';
export type Busy = 'continue' | 'passkey' | 'code' | 'verify' | 'resend' | 'apple';

export interface FlowState {
  mode: Mode;
  step: Step;
  email: string;
  name: string;
  code: string;
  /** Which confirm call the code step should make. */
  codePurpose: 'sign-in' | 'sign-up';
  /** Where the code went, when the service says. */
  destination: string | undefined;
  busy: Busy | null;
  error: string | null;
  notice: string | null;
}

export type FlowAction =
  | { type: 'set-mode'; mode: Mode }
  | { type: 'set-email'; email: string }
  | { type: 'set-name'; name: string }
  | { type: 'set-code'; code: string }
  | { type: 'go-email' }
  | { type: 'go-method' }
  | { type: 'go-code'; purpose: 'sign-in' | 'sign-up'; destination: string | undefined }
  | { type: 'busy'; busy: Busy }
  | { type: 'idle' }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string };

export function initialFlow(overrides: Partial<FlowState> = {}): FlowState {
  return {
    mode: 'sign-in',
    step: 'email',
    email: '',
    name: '',
    code: '',
    codePurpose: 'sign-in',
    destination: undefined,
    busy: null,
    error: null,
    notice: null,
    ...overrides,
  };
}

/** AUTH-03: syntactically valid — one @, something either side, a dot in the domain. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** AUTH-03: Continue is disabled until the address is valid (and, on sign-up, a name is present). */
export function canContinue(state: FlowState): boolean {
  if (!isValidEmail(state.email)) return false;
  if (state.mode === 'sign-up' && state.name.trim() === '') return false;
  return state.busy === null;
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'set-mode':
      // AUTH-02: switching preserves the typed email and resets to the email step.
      if (action.mode === state.mode) return state;
      return {
        ...state,
        mode: action.mode,
        step: 'email',
        code: '',
        busy: null,
        error: null,
        notice: null,
      };
    case 'set-email':
      return { ...state, email: action.email, error: null };
    case 'set-name':
      return { ...state, name: action.name, error: null };
    case 'set-code':
      return { ...state, code: action.code, error: null };
    case 'go-email':
      return { ...state, step: 'email', code: '', busy: null, error: null, notice: null };
    case 'go-method':
      return { ...state, step: 'method', code: '', busy: null, error: null, notice: null };
    case 'go-code':
      return {
        ...state,
        step: 'code',
        code: '',
        codePurpose: action.purpose,
        destination: action.destination,
        busy: null,
        error: null,
        notice: null,
      };
    case 'busy':
      return { ...state, busy: action.busy, error: null };
    case 'idle':
      return { ...state, busy: null };
    case 'error':
      return { ...state, busy: null, error: action.message };
    case 'notice':
      return { ...state, busy: null, notice: action.message };
  }
}
