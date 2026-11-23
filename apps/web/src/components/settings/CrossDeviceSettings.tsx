import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { usePeerLinkHosts } from "~/state/peerLinks";
import { Button } from "../ui/button";
import { LinuxSshDeviceSettings } from "./LinuxSshDeviceSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { WindowsCompanionSettings } from "./WindowsCompanionSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function CrossDeviceSettings() {
  const gt = useGT();
  const peerLinkHosts = usePeerLinkHosts();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const linkedEnvironmentsLabel = gt("Linked environments");

  return (
    <SettingsPageContainer>
      <SettingsSection id="cross-device-control" title={gt("Environment links")}>
        <SettingsRow
          serverScoped
          id={searchableSetting("linked-environments-beta").id}
          title={linkedEnvironmentsLabel}
          settingKeys={["linkedEnvironmentsEnabled"]}
          description={gt(
            "Let agents work across linked T3 Code environments. Turn this on for each environment you want to link. Turning it off lets running tasks finish.",
          )}
          control={
            <ScopedSwitch
              settingKeys={["linkedEnvironmentsEnabled"]}
              checked={settings.linkedEnvironmentsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ linkedEnvironmentsEnabled: Boolean(checked) })
              }
              aria-label={linkedEnvironmentsLabel}
            />
          }
        />
        <SettingsRow
          title={gt("Pair environments")}
          description={gt("Use a pairing code to link an environment and check its connection.")}
          control={
            <Button
              render={
                <Link
                  to="/settings/connections"
                  hash={peerLinkHosts.length > 0 ? "linked-environments" : "remote-environments"}
                />
              }
              variant="outline"
              size="sm-multiline"
            >
              {gt("Manage environments")}
            </Button>
          }
        />
      </SettingsSection>

      <WindowsCompanionSettings />
      <LinuxSshDeviceSettings />

      <SettingsSection title={gt("Device panel")}>
        <SettingsRow
          title={gt("Device support and agent access")}
          description={gt(
            "Set up iOS simulators and Android emulators, enable the Device panel, and choose whether agents can use devices.",
          )}
          control={
            <Button
              render={<Link to="/settings/devices" hash="devices" />}
              variant="outline"
              size="sm-multiline"
            >
              {gt("Open device settings")}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title={gt("Browser preview")}>
        <SettingsRow
          title={gt("Shared browser access")}
          description={gt(
            "Choose whether agents can use the shared browser. Desktop also has settings for browser profiles and the floating preview.",
          )}
          control={
            <Button
              render={<Link to="/settings/browser" hash="agent-browser-access" />}
              variant="outline"
              size="sm-multiline"
            >
              {gt("Open browser settings")}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
