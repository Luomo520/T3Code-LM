import { View } from "react-native";
import { Text } from "@expo/ui/jetpack-compose";
import { IconButton } from "../../components/ui/IconButton";
import { NativeAppBar } from "../../components/ui/NativeAppBar.android";

export function NativeAppBarExample() {
  return (
    <NativeAppBar
      title={<Text style={{ fontSize: 21 }}>{"原生应用栏"}</Text>}
      navigationIcon={
        <IconButton icon="arrow.left" accessibilityLabel="示例返回" onPress={() => {}} />
      }
      actions={
        <View className="flex-row">
          <IconButton
            icon="magnifyingglass"
            accessibilityLabel="示例搜索"
            onPress={() => {}}
          />
        </View>
      }
    />
  );
}
