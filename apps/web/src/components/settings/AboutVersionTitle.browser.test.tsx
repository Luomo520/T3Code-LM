import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { APP_VERSION } from "../../branding";
import { AnchoredToastProvider } from "../ui/toast";
import { AboutVersionTitle } from "./AboutVersionTitle";

it.each([undefined, "9.8.7-6"])(
  "copies the running version %s without a notification",
  async (nativeVersion) => {
    await using screen = await render(
      <AnchoredToastProvider>
        <AboutVersionTitle {...(nativeVersion === undefined ? {} : { version: nativeVersion })} />
      </AnchoredToastProvider>,
    );
    using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const version = nativeVersion ?? APP_VERSION;

    await screen.getByRole("button", { name: `Copy version ${version}` }).click();

    expect(write).toHaveBeenCalledWith(version);
    await expect.element(page.getByText(/^Copied!?$/)).not.toBeInTheDocument();
  },
);
