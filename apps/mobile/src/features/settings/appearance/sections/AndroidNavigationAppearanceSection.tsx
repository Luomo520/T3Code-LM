import { View } from "react-native";

import { ListChoiceRow as SettingsChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { ListToggleRow } from "../../../../components/ui/ListToggleRow";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

export function AndroidNavigationAppearanceSection() {
  const {
    isReady,
    androidNavigationStyle,
    setAndroidNavigationStyle,
    dockGlassEnabled,
    setDockGlassEnabled,
  } = useAppearancePreferences();
  return (
    <SettingsSection title="导航">
      <View accessibilityRole="radiogroup">
        <SettingsChoiceRow
          label="One UI"
          description="悬浮底栏与独立的新会话按钮"
          disabled={!isReady}
          selected={androidNavigationStyle === "one-ui"}
          onPress={() => setAndroidNavigationStyle("one-ui")}
        />
        <SettingsChoiceRow
          label="Material"
          description="Android 底部导航栏和侧边导航栏"
          disabled={!isReady}
          selected={androidNavigationStyle === "material"}
          onPress={() => setAndroidNavigationStyle("material")}
          separated
        />
      </View>
      <ListToggleRow
        label="Dock 玻璃效果"
        description="应用于悬浮底栏"
        disabled={!isReady}
        value={dockGlassEnabled}
        onValueChange={setDockGlassEnabled}
      />
    </SettingsSection>
  );
}
