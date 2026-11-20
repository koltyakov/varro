#define main notifierMain
#import "main.m"
#undef main

// A fake center makes removal of any unrelated identifier fail without touching real notifications.
@interface TestNotificationCenter : NSObject
@property BOOL removedPending;
@property BOOL removedDelivered;
@end

@implementation TestNotificationCenter
- (void)removePendingNotificationRequestsWithIdentifiers:(NSArray<NSString *> *)identifiers {
  if (![identifiers isEqualToArray:@[@"window-a-first", @"window-a-second"]]) {
    fail(@"Removed unrelated pending notifications.", 10);
  }
  self.removedPending = YES;
}

- (void)removeDeliveredNotificationsWithIdentifiers:(NSArray<NSString *> *)identifiers {
  if (!self.removedPending || ![identifiers isEqualToArray:@[@"window-a-first", @"window-a-second"]]) {
    fail(@"Removed unrelated delivered notifications.", 11);
  }
  self.removedDelivered = YES;
}

- (void)getDeliveredNotificationsWithCompletionHandler:(void (^)(NSArray<UNNotification *> *))completionHandler {
  if (!self.removedPending || !self.removedDelivered) fail(@"Did not remove both notification types.", 12);
  // The helper must wait for this asynchronous acknowledgement instead of exiting immediately.
  dispatch_async(dispatch_get_main_queue(), ^{ completionHandler(@[]); });
}
@end

int main(void) {
  @autoreleasepool {
    TestNotificationCenter *center = [TestNotificationCenter new];
    dismissNotifications((UNUserNotificationCenter *)center, @[@"window-a-first", @"window-a-second"]);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
      fail(@"Dismissal did not finish.", 13);
    });
    dispatch_main();
  }
}
