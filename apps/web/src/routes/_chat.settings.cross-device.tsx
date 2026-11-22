import { createFileRoute } from "@tanstack/react-router";
import { CrossDeviceSettings } from "../components/settings/CrossDeviceSettings";

export const Route = createFileRoute("/_chat/settings/cross-device")({
  component: CrossDeviceSettings,
});
