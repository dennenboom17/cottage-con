import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// ── Firebase is mocked wholesale: importing App.jsx must never touch the network ──
vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
}))

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ name: 'test-auth' })),
  onAuthStateChanged: vi.fn(() => () => {}),
  createUserWithEmailAndPassword: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(async () => {}),
  updateProfile: vi.fn(async () => {}),
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendEmailVerification: vi.fn(async () => {}),
}))

// `collection(db, name)` returns a plain tagged object so tests can tell listeners apart by collection name
vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({ name: 'test-db' })),
  doc: vi.fn((db, col, id) => ({ col, id })),
  collection: vi.fn((db, name) => ({ name })),
  setDoc: vi.fn(async () => {}),
  getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
  deleteDoc: vi.fn(async () => {}),
  onSnapshot: vi.fn(() => () => {}),
}))

vi.mock('firebase/messaging', () => ({
  getMessaging: vi.fn(() => ({})),
  getToken: vi.fn(async () => 'test-token'),
  onMessage: vi.fn(() => () => {}),
  isSupported: vi.fn(async () => false),
}))

// jsdom gaps the app relies on
window.scrollTo = vi.fn()
Element.prototype.scrollIntoView = vi.fn()

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
