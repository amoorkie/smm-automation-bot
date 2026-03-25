import { createRuntimeContext } from './app.mjs';

let contextPromise = null;

export function getVercelContext() {
  if (!contextPromise) {
    contextPromise = createRuntimeContext();
  }
  return contextPromise;
}

export default getVercelContext;
