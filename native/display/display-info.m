#import <UIKit/UIKit.h>
#import <dlfcn.h>
#import <string.h>
@interface NSObject (ISimBotDisplayOrientation)
- (NSInteger)activeInterfaceOrientation;
- (void)invalidate;
@end
// Short-lived simulator process. Reads the foreground interface orientation;
// does not inject into an app or monitor host input.
int main(int argc, const char *argv[]) {
 @autoreleasepool {
  @try {
   if (argc == 2 && strcmp(argv[1], "--scale") == 0) {
    CGFloat scale = UIScreen.mainScreen.nativeScale;
    if (!isfinite(scale) || scale <= 0) return 3;
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"scale": @(scale)} options:0 error:nil];
    if (!data) return 4;
    [NSFileHandle.fileHandleWithStandardOutput writeData:data];
    return 0;
   }
   void *framework=dlopen("/System/Library/PrivateFrameworks/FrontBoardServices.framework/FrontBoardServices",RTLD_NOW);
   Class observerClass=NSClassFromString(@"FBSOrientationObserver");
   if(!framework || ![observerClass instancesRespondToSelector:@selector(activeInterfaceOrientation)]) return 2;
   id observer=[observerClass new];NSInteger orientation=[observer activeInterfaceOrientation];
   if([observer respondsToSelector:@selector(invalidate)]) [observer invalidate];
   UIScreen *screen=UIScreen.mainScreen;CGFloat scale=screen.nativeScale;CGRect bounds=screen.nativeBounds;
   if(orientation<1 || orientation>4 || scale<=0 || bounds.size.width<=0 || bounds.size.height<=0) return 3;
   NSDictionary *info=@{@"orientation":@(orientation),@"width":@(bounds.size.width/scale),@"height":@(bounds.size.height/scale)};
   NSData *data=[NSJSONSerialization dataWithJSONObject:info options:0 error:nil];
   if(!data) return 4;
   [NSFileHandle.fileHandleWithStandardOutput writeData:data];return 0;
  } @catch(NSException *exception) { return 5; }
 }
}
