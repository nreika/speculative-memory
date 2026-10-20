/** Every caller of the same Ollama model must use the same runner context.
 * A smaller per-task output budget remains independent; do not shrink instructions or num_predict here.
 * 8192 is the current planner capacity and the measured RTX4060 profile.
 */
export function sharedOllamaContextLength(env:NodeJS.ProcessEnv=process.env):number {
 const value=Number(env.VLM_NUM_CTX??8192);
 return Number.isSafeInteger(value)&&value>=8192&&value<=131072?value:8192;
}
