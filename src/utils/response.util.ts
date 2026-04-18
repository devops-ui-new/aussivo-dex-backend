import { Response } from 'express';
export interface IResponse {
  data: any;
  error: string | null;
  message: string;
  status: number;
}
export const sendResponse = (res: Response, status: number, data: IResponse) => {
  return res.status(status).json(data);
};
