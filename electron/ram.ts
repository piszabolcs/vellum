import * as os from 'os';
import { RamInfo } from './shared';

/**
 * A Node beépített `os` modulja mindig, szinkron módon elérhető – nincs
 * külső binárishoz kötött hibamód, mint a `queryGpu`-nál, ezért itt nincs
 * try/catch vagy null-ra visszatérő eset.
 */
export function queryRam(): RamInfo {
  const totalMb = os.totalmem() / (1024 * 1024);
  const freeMb = os.freemem() / (1024 * 1024);
  return { totalMb, usedMb: totalMb - freeMb };
}
