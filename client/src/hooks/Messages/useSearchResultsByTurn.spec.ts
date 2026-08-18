import { renderHook } from '@testing-library/react';
import { Tools } from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';
import { useSearchResultsByTurn } from './useSearchResultsByTurn';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('useSearchResultsByTurn', () => {
  /* exode fork: `sourceUrl` (the original document's URL on main's own storage — see
   * fileSearch.js's `sources` mapping) must survive this hook's re-shaping of the raw
   * `file_search` artifact into `references`, or `Citation.tsx` never sees it and the
   * "open original" action never appears regardless of what the backend sent. */
  it('carries sourceUrl through onto the file reference', () => {
    const attachments = [
      {
        type: Tools.file_search,
        [Tools.file_search]: {
          sources: [
            {
              fileId: 'file-1',
              fileName: 'doc.pdf',
              sourceUrl: 'https://storage.exode.biz/staging/school/1798/doc.pdf',
            },
          ],
        },
      },
    ] as unknown as TAttachment[];

    const { result } = renderHook(() => useSearchResultsByTurn(attachments));

    expect(result.current['0'].references?.[0]).toMatchObject({
      fileId: 'file-1',
      sourceUrl: 'https://storage.exode.biz/staging/school/1798/doc.pdf',
    });
  });

  it('leaves sourceUrl undefined when the source never had one', () => {
    const attachments = [
      {
        type: Tools.file_search,
        [Tools.file_search]: {
          sources: [{ fileId: 'file-1', fileName: 'doc.pdf' }],
        },
      },
    ] as unknown as TAttachment[];

    const { result } = renderHook(() => useSearchResultsByTurn(attachments));

    expect(result.current['0'].references?.[0]).toMatchObject({ sourceUrl: undefined });
  });
});
