import {promises as fs} from "node:fs";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {UserStore, hashPassword} from "./auth";
import {ConsoleError} from "./backend/config";
type Entry = {id:string;username:string;passwordHash?:string;createdAt:number;state:"pending"|"approved"|"rejected";reviewedAt?:number};
export class RegistrationQueue {
  private entries: Entry[] = [];
  private writing: Promise<unknown> = Promise.resolve();
  constructor(readonly file:string, private users:UserStore) {}
  async load() {
    try {
      const rows=JSON.parse(await fs.readFile(this.file,"utf8"));
      if (!Array.isArray(rows) || rows.length>500 || rows.some(e=>!e || !/^[a-f0-9-]{36}$/.test(e.id) ||
          !/^[a-zA-Z0-9_.@-]{1,80}$/.test(e.username) || !Number.isFinite(e.createdAt) || !["pending","approved","rejected"].includes(e.state) ||
          (e.state==="pending" && !/^scrypt\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(e.passwordHash)))) throw new Error("Invalid registration database");
      if(new Set(rows.map(e=>e.id)).size!==rows.length)throw new Error("Duplicate registration IDs");
      this.entries=rows;
    } catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e; }
  }
  private serial<T>(fn:()=>Promise<T>):Promise<T> { const job=this.writing.then(fn);this.writing=job.catch(()=>{});return job; }
  private async save(next:Entry[]) {
    const pending=next.filter(e=>e.state==="pending"),closed=next.filter(e=>e.state!=="pending").slice(-Math.max(0,500-pending.length));
    const retained=[...closed,...pending];await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
    const temp=this.file+"."+randomUUID()+".tmp";await fs.writeFile(temp,JSON.stringify(retained)+"\n",{flag:"wx",mode:0o600});
    await fs.rename(temp,this.file);this.entries=retained;
  }
  list() { return this.entries.filter(e=>e.state==="pending").map(({id,username,createdAt})=>({id,username,createdAt})); }
  submit(username:string,password:string) { return this.serial(async()=>{
    if(typeof username!=="string" || !/^[a-zA-Z0-9_.@-]{1,80}$/.test(username))throw new ConsoleError(400,"INVALID_USER","用户名格式不正确。");
    if(this.users.users.some(u=>u.username.toLowerCase()===username.toLowerCase()) || this.entries.some(e=>e.state==="pending"&&e.username.toLowerCase()===username.toLowerCase()))throw new ConsoleError(400,"REGISTRATION_EXISTS","用户名或待审批申请已存在。");
    if(this.entries.filter(e=>e.state==="pending").length>=200)throw new ConsoleError(429,"REGISTRATION_CAPACITY","待审批申请已满，请稍后再试。");
    const entry:Entry={id:randomUUID(),username,passwordHash:await hashPassword(password),createdAt:Date.now(),state:"pending"};
    await this.save([...this.entries,entry]);return {pending:true,message:"注册申请已提交，管理员批准后才能登录。"};
  }); }
  review(id:string,decision:unknown) { return this.serial(async()=>{
    if(decision!=="approve"&&decision!=="reject")throw new ConsoleError(400,"INVALID_DECISION","请选择同意或拒绝。");
    const entry=this.entries.find(e=>e.id===id);if(!entry)throw new ConsoleError(404,"REGISTRATION_MISSING","申请不存在。");
    const state=decision==="approve"?"approved":"rejected";
    if(entry.state===state)return {ok:true,state};
    if(entry.state!=="pending")throw new ConsoleError(409,"REGISTRATION_REVIEWED","申请已处理。");
    // If a crash occurs after creating the account, the stable ID makes retry idempotent.
    if(decision==="approve")await this.users.approveRegistration(entry.id,entry.username,entry.passwordHash!);
    const updated:Entry={id:entry.id,username:entry.username,createdAt:entry.createdAt,state,reviewedAt:Date.now()};
    await this.save(this.entries.map(e=>e.id===id?updated:e));return {ok:true,state};
  }); }
}
