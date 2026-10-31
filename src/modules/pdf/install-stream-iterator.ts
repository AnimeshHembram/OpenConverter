/** Side-effect module: imported first so the iterator exists before pdf.js runs. */
import { installStreamIterator } from './stream-iterator';

installStreamIterator();
