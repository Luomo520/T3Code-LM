import { useAtomValue } from "@effect/atom-react";
import { Pressable, Text, View } from "react-native";

import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import {
  recheckThreadMessageDelivery,
  retryThreadMessageDelivery,
  threadMessageDeliveryStates,
} from "../../state/thread-message-delivery";

export function PendingMessageDelivery({ message }: { readonly message: QueuedThreadMessage }) {
  const state = useAtomValue(
    threadMessageDeliveryStates,
    (statuses) => statuses[message.messageId],
  );
  if (state === "legacy-unconfirmed") {
    return (
      <View className="flex-row items-center gap-2">
        <Text className="text-xs text-foreground-secondary">旧版服务端无法确认投递</Text>
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => recheckThreadMessageDelivery(message.messageId)}
        >
          <Text className="font-t3-medium text-xs text-foreground">重新确认</Text>
        </Pressable>
      </View>
    );
  }
  if (state !== "resend") {
    return <Text className="text-xs text-foreground-secondary">确认中</Text>;
  }
  return (
    <View className="flex-row items-center gap-2">
      <Text className="text-xs text-foreground-secondary">尚未收到</Text>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => retryThreadMessageDelivery(message.messageId)}
      >
        <Text className="font-t3-medium text-xs text-foreground">重发</Text>
      </Pressable>
    </View>
  );
}
