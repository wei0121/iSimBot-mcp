#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <fcntl.h>
#import <unistd.h>
#import <sys/stat.h>

// Original implementation: observes events inside the explicitly launched app.
// No host input monitoring, Bonjour, keyboard interception or text collection.
static NSString *leasePath;
static NSString *sessionId;
static NSString *snapshotPath;
static BOOL observing;
static NSTimeInterval wallClockOffset;
static dispatch_queue_t writer;
static dispatch_source_t flushTimer;
static NSMutableArray *samples;
static NSDictionary *handshake;
static BOOL dirty;
static void flushSnapshot(void) {
    if (!dirty) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"sessionId": sessionId, @"handshake": handshake ?: @{}, @"samples": samples} options:0 error:nil];
    if (data) [data writeToFile:snapshotPath options:NSDataWritingAtomic error:nil];
    dirty = NO;
}
static void emit(NSDictionary *value) {
    NSMutableDictionary *message = [value mutableCopy];
    message[@"sessionId"] = sessionId;
    dispatch_async(writer, ^{
        if ([message[@"type"] isEqual:@"ready"]) handshake = message;
        else if (samples.count < 100000) [samples addObject:message];
        else if (samples.count == 100000) [samples addObject:@{@"type": @"limit", @"sessionId": sessionId}];
        dirty = YES;
    });
}
@implementation UIApplication (ISimBotObservation)
- (void)isimbot_observation_sendEvent:(UIEvent *)event {
    struct stat lease;
    if (observing && (stat(leasePath.fileSystemRepresentation, &lease) != 0 || time(NULL) - lease.st_mtime > 10)) {
        observing = NO;
    }
    NSMutableArray *touches = [NSMutableArray array];
    NSMutableArray *scrollReferences = [NSMutableArray array];
    if (observing && event.type == UIEventTypeTouches) {
        for (UITouch *touch in event.allTouches) {
            if (!touch.window || touch.phase == UITouchPhaseStationary) continue;
            CGPoint point = [touch.window convertPoint:[touch locationInView:touch.window] toCoordinateSpace:touch.window.screen.coordinateSpace];
            NSMutableArray *scrollViews = [NSMutableArray array];
            for (UIView *view = touch.view; view; view = view.superview) {
                if (![view isKindOfClass:UIScrollView.class]) continue;
                UIScrollView *scroll = (UIScrollView *)view;
                if (!scroll.scrollEnabled) continue;
                [scrollViews addObject:scroll];
            }
            [scrollReferences addObject:scrollViews];
            [touches addObject:[@{@"id": [NSString stringWithFormat:@"%p", touch], @"phase": @(touch.phase),
                @"x": @(point.x), @"y": @(point.y), @"touchTime": @(touch.timestamp), @"tapCount": @(touch.tapCount)} mutableCopy]];
        }
    }
    // Preserve touch data before an action can remove its view/window. Read the
    // recognizer state after dispatch, when UIKit has processed this event.
    [self isimbot_observation_sendEvent:event];
    if (touches.count) {
        for (NSUInteger index = 0; index < touches.count; index++) {
            NSMutableArray *contexts = [NSMutableArray array];
            for (UIScrollView *scroll in scrollReferences[index]) {
                [contexts addObject:@{@"id": [NSString stringWithFormat:@"%p", scroll],
                    @"panState": @(scroll.panGestureRecognizer.state),
                    @"offsetX": @(scroll.contentOffset.x), @"offsetY": @(scroll.contentOffset.y)}];
            }
            touches[index][@"scrollViews"] = contexts;
        }
        emit(@{@"type": @"touch", @"time": @((wallClockOffset + event.timestamp) * 1000), @"touches": touches});
    }
}
+ (void)load {
    @autoreleasepool {
        NSString *session = NSProcessInfo.processInfo.environment[@"ISIMBOT_OBSERVATION_SESSION"];
        if (!session || session.length != 36 || [session rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef-"] invertedSet]].location != NSNotFound) return;
        NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:[@"isimbot-observation-" stringByAppendingString:session]];
        leasePath = [directory stringByAppendingPathComponent:@"active"];
        if (![[NSFileManager defaultManager] fileExistsAtPath:leasePath]) return;
        sessionId = session;
        snapshotPath = [directory stringByAppendingPathComponent:@"samples.json"];
        if ([[NSFileManager defaultManager] fileExistsAtPath:snapshotPath]) return;
        observing = YES;
        samples = [NSMutableArray array];
        writer = dispatch_queue_create("dev.isimbot.observation.writer", DISPATCH_QUEUE_SERIAL);
        flushTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, writer);
        dispatch_source_set_timer(flushTimer, dispatch_time(DISPATCH_TIME_NOW, 0), 100 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
        dispatch_source_set_event_handler(flushTimer, ^{ flushSnapshot(); });
        dispatch_resume(flushTimer);
        wallClockOffset = [NSDate date].timeIntervalSince1970 - NSProcessInfo.processInfo.systemUptime;
        Method original = class_getInstanceMethod(self, @selector(sendEvent:));
        Method observer = class_getInstanceMethod(self, @selector(isimbot_observation_sendEvent:));
        method_exchangeImplementations(original, observer);
        emit(@{@"type": @"ready", @"time": @([NSDate date].timeIntervalSince1970 * 1000), @"protocol": @2,
            @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"", @"pid": @(getpid())});
    }
}
@end
