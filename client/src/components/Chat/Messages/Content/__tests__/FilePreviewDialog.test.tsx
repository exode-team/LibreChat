import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { RecoilRoot } from 'recoil';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useFileDownload: () => ({ refetch: jest.fn() }),
  useSharedFileDownload: () => ({ refetch: jest.fn() }),
}));

jest.mock('~/Providers', () => ({
  useShareContext: () => ({ shareId: undefined }),
}));

/* exode fork: `sourceUrl` (main's original-document URL) is a user-controlled upload-time form
 * field that ends up interpolated into an `<a href>` here ("Open original"). Unvalidated, a
 * `javascript:`/`data:` value would be a clickable XSS vector — this pins the render-time
 * sanitization (getSafeExternalUrl) that must survive independently of the server-side check in
 * process.js, since a stored value must never be trusted at the render boundary either. */
describe('FilePreviewDialog — sourceUrl sanitization', () => {
  const baseProps = {
    open: true,
    onOpenChange: jest.fn(),
    fileName: 'doc.pdf',
    fileId: 'file-1',
  };

  function renderDialog(sourceUrl?: string) {
    return render(
      <RecoilRoot>
        <FilePreviewDialog {...baseProps} sourceUrl={sourceUrl} />
      </RecoilRoot>,
    );
  }

  it('renders an "open original" link for a safe https URL', () => {
    renderDialog('https://storage.exode.biz/staging/school/1798/doc.pdf');

    expect(screen.getByRole('link', { name: /com_ui_open_original/ })).toHaveAttribute(
      'href',
      'https://storage.exode.biz/staging/school/1798/doc.pdf',
    );
  });

  it('renders nothing for a javascript: URL', () => {
    renderDialog('javascript:alert(1)');

    expect(screen.queryByRole('link', { name: /com_ui_open_original/ })).not.toBeInTheDocument();
  });

  it('renders nothing for a data: URL', () => {
    renderDialog('data:text/html,<script>alert(1)</script>');

    expect(screen.queryByRole('link', { name: /com_ui_open_original/ })).not.toBeInTheDocument();
  });

  it('renders nothing for an unparsable string', () => {
    renderDialog('not a url at all');

    expect(screen.queryByRole('link', { name: /com_ui_open_original/ })).not.toBeInTheDocument();
  });

  it('renders nothing when sourceUrl is absent', () => {
    renderDialog(undefined);

    expect(screen.queryByRole('link', { name: /com_ui_open_original/ })).not.toBeInTheDocument();
  });
});
