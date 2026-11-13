import { BoardPage } from './board.mjs';

/**
 * 只读查看：通过页面自身渲染、虚拟滚动与临时展开读取全部卡片。
 * 不会分派、不会改写页面数据。
 */
export async function inspect(base) {
  const board = await BoardPage.open(base);
  try {
    const snapshot = await board.snapshot();
    return snapshot.cards.map(card => ({
      text: card.text,
      key: card.key,
      version: String(card.version),
      voyage: card.voyage,
      lane: card.lane
    }));
  } finally {
    await board.close();
  }
}
