import { InMemoryStore } from "../in-memory-store.ts";
import { runStoreContractTests } from "./contract.ts";

runStoreContractTests("InMemoryStore", () => Promise.resolve(new InMemoryStore()));
