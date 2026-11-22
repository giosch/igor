import path from 'node:path';
import { check, safeRelative } from '../core.js';

export class DevelopmentSandbox {
  name = 'development-mock';
  prepare(paths, agent) {
    check(agent === 'mock', 'Real Pi execution requires macOS Seatbelt', 5);
    return { code: paths.code, docs: paths.docs, secure: false };
  }
  writeTarget(session, name) {
    return path.join(session.code, safeRelative(name));
  }
}
