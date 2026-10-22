import { RedisCacheService } from "./redis-cache";

export const redisCacheService = new RedisCacheService();

export const redisSessionStore = new RedisCacheService('critical');
