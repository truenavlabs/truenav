// Fill the help-bubble AI slot. The bubble already searches the FAQ in the browser if this returns null.
import { askAssist } from "../lib/assist";
import { SLOTS } from "./slots";

SLOTS.ask = (question, page, history) => askAssist(question, page, history);
