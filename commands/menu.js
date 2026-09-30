import { menuText } from "../lib/helpers.js";

export default async function menu({ reply }) {
  await reply(menuText());
}