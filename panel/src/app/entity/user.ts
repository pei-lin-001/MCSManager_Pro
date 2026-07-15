import { IUser } from "./entity_interface";

export enum UserPassWordType {
  md5 = 0,
  bcrypt = 1
}

export interface IUserApp {
  instanceUuid: string;
  daemonId: string;
  instanceInfo?: any;
}

export class User implements IUser {
  uuid: string = "";
  userName: string = "";
  passWord: string = "";
  passWordType: number = UserPassWordType.bcrypt;
  salt: string = "";
  permission: number = 0;
  registerTime: string = "";
  loginTime: string = "";
  instances: Array<IUserApp> = [];
  apiKey: string = "";
  isInit: boolean = false;
  secret = "";
  open2FA = false;
  ssoSub = "";
  ssoBound = false;
  mcName = "";
  mcUuid = "";
  bindAt = 0;
  activityPoints = 0;
  checkIn: { lastDate?: string; streak?: number } = {};
}

export enum ROLE {
  /** Super admin: full panel control */
  ADMIN = 10,
  /** Manager/operator: instance ops, no system settings */
  MANAGER = 5,
  /** End user: character hub only, no instance operations */
  USER = 1,
  GUEST = 0,
  BAN = -1
}
