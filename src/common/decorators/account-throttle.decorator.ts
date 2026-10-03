import { SetMetadata } from '@nestjs/common';
export const ACCOUNT_THROTTLE_KEY = 'account-throttle';
export const AccountThrottle = () => SetMetadata(ACCOUNT_THROTTLE_KEY, true);
