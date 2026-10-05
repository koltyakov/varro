#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <UserNotifications/UserNotifications.h>
#import <os/log.h>
#import <objc/runtime.h>

static void responseTestExit(int code);
#define exit responseTestExit
#define main notifierMain
#import "main.m"
#undef main
#undef exit

static NSMutableArray<NSString *> *events;
static NSString *openedURL;
static BOOL openResult;

static BOOL recordOpen(id workspace, SEL selector, NSURL *url) {
  (void)workspace;
  (void)selector;
  [events addObject:@"open"];
  openedURL = url.absoluteString;
  return openResult;
}

static void responseTestExit(int code) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{
    @"events": events, @"url": openedURL ?: @"", @"exitCode": @(code)
  } options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fflush(stdout);
  exit(code);
}

// These stand-ins implement only the framework's immutable response accessors.
// The production delegate, URL validation, dispatch and completion ordering run unchanged.
@interface TestNotification : NSObject
@property UNNotificationRequest *request;
@end
@implementation TestNotification
@end

@interface TestResponse : NSObject
@property NSString *actionIdentifier;
@property TestNotification *notification;
@end
@implementation TestResponse
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 4) return 2;
    events = [NSMutableArray array];
    openResult = strcmp(argv[3], "success") == 0;
    Method openMethod = class_getInstanceMethod(NSWorkspace.class, @selector(openURL:));
    method_setImplementation(openMethod, (IMP)recordOpen);
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    if (argv[2][0]) content.userInfo = @{ @"url": @(argv[2]) };
    TestNotification *notification = [TestNotification new];
    notification.request = [UNNotificationRequest requestWithIdentifier:@"click-test" content:content trigger:nil];
    TestResponse *response = [TestResponse new];
    response.notification = notification;
    response.actionIdentifier = strcmp(argv[1], "default") == 0 ? UNNotificationDefaultActionIdentifier : UNNotificationDismissActionIdentifier;
    VarroNotifications *delegate = [VarroNotifications new];
    [delegate userNotificationCenter:nil didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:^{
      [events addObject:@"complete"];
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ responseTestExit(99); });
    dispatch_main();
  }
}
