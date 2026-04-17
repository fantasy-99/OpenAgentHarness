import { expect, test } from "@playwright/test";

test.describe("web app smoke", () => {
  test("app shell renders without crashing", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Open Agent Harness").first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "Runtime" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Provider" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Storage" })).toBeVisible();
  });

  test("pinging health through the vite proxy reaches the backend", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Provider" }).click();

    const baseUrlInput = page.getByPlaceholder("Base URL");
    await expect(baseUrlInput).toBeVisible();
    await baseUrlInput.fill("");

    const healthRequest = page.waitForResponse(
      (response) => response.url().endsWith("/healthz") && response.status() === 200
    );
    await page.getByRole("main").getByRole("button", { name: "Health" }).click();
    await healthRequest;

    await expect(page.getByText(/health ok/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
