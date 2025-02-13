import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {User} from "./model/user.model";
import {UserData} from "./model/user-data.model";
import {EarnTask} from "./model/earn-task.model";
import { EarnTaskType } from 'src/constants/enums/earn-task-type';
import {Referral} from "./model/referral.model";
import {UserRequestDto} from "./dto/user-request.dto";
import {userDefaultConfig} from "../config/user-default-config";
import {generateReferralCode, getReferrerId} from "../helpers/referral";
import {msToSeconds} from "../helpers/ms-to-seconds";
import {UserResponseDto} from "./dto/user-response.dto";
import {calcUserEarnByTap, calcUserEnergyPerSecond, calcUserMaxEnergy} from "../helpers/user-calculated-params";
import {levels} from "../config/levels";
import {referralBonus} from "../config/referral-bonus";
import {daily} from "../config/daily";
import {maxEnergyBoost} from "../config/max-energy-boost";
import {energyPerSecondBoost} from "../config/energy-per-second-boost";
import {earnByTapBoost} from "../config/earn-by-tap-boost";
import {InvitedDto} from "./dto/invited.dto";
import {LeaderboardResponseDto} from "./dto/leaderboard-response.dto";
import {StatsService} from "../stats/stats.service";




@Injectable()
export class UsersService {
	private readonly logger = new Logger(UsersService.name);

	@InjectModel(User.name) private userModel: Model<User>;

	constructor(
		@InjectModel(User.name) userModel: Model<User>,
		@InjectModel(UserData.name) private userDataModel: Model<UserData>,
		@InjectModel(EarnTask.name) private earnTaskModel: Model<EarnTask>,
		@InjectModel(Referral.name) private referralModel: Model<Referral>,
		private statsService: StatsService,
	) {
		this.userModel = userModel;
	}


	private async getUserByTelegramId(telegramId: string): Promise<User> {
		return this.userModel.findOne({ telegramId }).exec();
	}

	private async getUserDataByTelegramId(telegramId: string): Promise<UserData> {
		return this.userDataModel.findOne({ telegramId }).exec();
	}

	private async createUser(userRequest: UserRequestDto): Promise<User> {
		const initData = userRequest.initData;
		const user = new this.userModel({
			telegramId: `${initData.user.id}`,
			username: initData.user.username || '',
			firstName: initData.user.firstName,
			lastName: initData.user.lastName || '',
			languageCode: initData.user.languageCode || '',
			isPremium: initData.user.isPremium || false,
			allowsWriteToPm: initData.user.allowsWriteToPm || false,
			profilePicture: '',
			balance: 0n,
			level: userDefaultConfig.level,
			referralCode: generateReferralCode(initData.user.id),
		});
		return user.save();
	}

	private async createUserData(user: User): Promise<UserData> {
		const userData = new this.userDataModel({
			telegramId: user.telegramId,
			energy: userDefaultConfig.energy,
			earnByTapBoosterLevel: userDefaultConfig.earnByTapBoosterLevel,
			energyPerSecondBoosterLevel: userDefaultConfig.energyPerSecondBoosterLevel,
			maxEnergyBoosterLevel: userDefaultConfig.maxEnergyBoosterLevel,
			earnPerHourBonus: userDefaultConfig.earnPerHourBonus,
			lastEnergyUpdateTimestamp: msToSeconds(Date.now()),
			lastTapTimestamp: userDefaultConfig.lastTapTimestamp,
			lastDailyClaimTimestamp: userDefaultConfig.lastDailyClaimTimestamp,
			prevDailyClaimTimestamp: userDefaultConfig.prevDailyClaimTimestamp,
			dailyStreak: userDefaultConfig.dailyStreak,
			lastFullEnergyBonusTimestamp: userDefaultConfig.lastFullEnergyBonusTimestamp,
			fullEnergyBonusCount: userDefaultConfig.fullEnergyBonusCount,
		});
		return userData.save();
	}

	private async getUserAllData(telegramId: string): Promise<UserResponseDto> {
		const user = await this.getUserByTelegramId(telegramId);
		const userData = await this.getUserDataByTelegramId(telegramId);

		if (!user || !userData) {
			return null;
		}

		return {
			telegramId: user.telegramId,
			firstName: user.firstName,
			lastName: user.lastName,
			username: user.username,
			isPremium: user.isPremium,
			allowsWriteToPm: user.allowsWriteToPm,
			referralCode: user.referralCode,
			languageCode: user.languageCode,
			profilePicture: user.profilePicture,
			balance: user.balance.toString(),
			level: user.level,
			energy: userData.energy.toString(),
			earnByTapBoosterLevel: userData.earnByTapBoosterLevel,
			energyPerSecondBoosterLevel: userData.energyPerSecondBoosterLevel,
			maxEnergyBoosterLevel: userData.maxEnergyBoosterLevel,
			earnPerHourBonus: userData.earnPerHourBonus.toString(),
			lastEnergyUpdateTimestamp: userData.lastEnergyUpdateTimestamp,
			lastTapTimestamp: userData.lastTapTimestamp,
			lastDailyClaimTimestamp: userData.lastDailyClaimTimestamp,
			prevDailyClaimTimestamp: userData.prevDailyClaimTimestamp,
			dailyStreak: userData.dailyStreak,
			lastFullEnergyBonusTimestamp: userData.lastFullEnergyBonusTimestamp,
			fullEnergyBonusCount: userData.fullEnergyBonusCount,
			teamId: userData.teamId,
			earnTaskIds: userData.earnTaskIds,
			maxEnergy: calcUserMaxEnergy(user.level, userData.maxEnergyBoosterLevel),
			energyPerSecond: calcUserEnergyPerSecond(user.level, userData.energyPerSecondBoosterLevel),
			earnPerTap: calcUserEarnByTap(user.level, userData.earnByTapBoosterLevel),
		};
	}

	private async updateEnergy(user: User, userData: UserData): Promise<void> {
		const now = msToSeconds(Date.now());
		const energyToAdd = (now - userData.lastEnergyUpdateTimestamp) * calcUserEnergyPerSecond(user.level, userData.energyPerSecondBoosterLevel);
		const maxEnergy = calcUserMaxEnergy(user.level, userData.maxEnergyBoosterLevel);
		const newEnergy = BigInt(userData.energy) + BigInt(energyToAdd);
		userData.energy = newEnergy > BigInt(maxEnergy) ? BigInt(maxEnergy) : newEnergy;
		userData.lastEnergyUpdateTimestamp = now;
		await userData.save();
	}

	private async increaseBalance(user: User, amount: number): Promise<void> {
		const updatedUser = await this.userModel.findOneAndUpdate(
			{ _id: user._id },
			{ $set: { balance: user.balance + BigInt(amount) } },
			{ new: true }
		).exec();

		const nextLevel = levels[updatedUser.level + 1];
		if (nextLevel && updatedUser.balance >= BigInt(nextLevel.pointsToGet)) {
			await this.userModel.updateOne(
				{ _id: user._id },
				{ $inc: { level: 1 } }
			).exec();
		}
	}

	private async decreaseBalance(user: User, amount: number): Promise<boolean> {
		if (user.balance < BigInt(amount)) {
			return false;
		}

		await this.userModel.findOneAndUpdate(
			{ _id: user._id },
			{ $set: { balance: user.balance - BigInt(amount) } },
			{ new: true }
		).exec();

		return true;
	}

	private async _getTasks(): Promise<EarnTask[]> {
		return this.earnTaskModel.find().exec();
	}

	async getOrCreateUser(userRequest: UserRequestDto): Promise<UserResponseDto> {
		const initData = userRequest.initData;
		let user = await this.getUserByTelegramId(`${initData.user.id}`);
		let userData = await this.getUserDataByTelegramId(`${initData.user.id}`);

		if (!user) {
			user = await this.createUser(userRequest);
		}

		if (!userData) {
			userData = await this.createUserData(user);

			const referralCode = userRequest.initData.startParam;
			if (referralCode) {
				const referrerUserId = getReferrerId(referralCode);
				if (referrerUserId !== user.telegramId) {
					const referrerUser = await this.getUserByTelegramId(referrerUserId);
					if (referrerUser) {
						const invited = new this.referralModel({
							invitedId: userData.telegramId,
							referrerId: referrerUser.telegramId,
							invitedPremium: !!user.isPremium,
							reward: user.isPremium ? referralBonus.premium : referralBonus.regular,
							username: user.username || '',
							firstName: user.firstName,
							lastName: user.lastName || '',
							referralCode: referralCode,
						});
						await invited.save();
						await this.increaseBalance(referrerUser, invited.reward);
						await this.increaseBalance(user, invited.reward);
					}
				}
			}
			await this.statsService.incrementTotalUsers();
		}

		await this.updateEnergy(user, userData);

		return this.getUserAllData(userData.telegramId);
	}

	async setTeam(userRequest: UserRequestDto, teamId: number): Promise<UserResponseDto> {
		const initData = userRequest.initData;
		const userData = await this.getUserDataByTelegramId(`${initData.user.id}`);

		if (!userData) {
			throw new NotFoundException('User not found');
		}

		userData.teamId = teamId;
		await userData.save();

		return this.getUserAllData(userData.telegramId);
	}

	async tap(userRequest: UserRequestDto, count: number): Promise<UserResponseDto> {
		const initData = userRequest.initData;
		const user = await this.getUserByTelegramId(`${initData.user.id}`);
		const userData = await this.getUserDataByTelegramId(`${initData.user.id}`);

		if (!userData || !user) {
			throw new NotFoundException('User not found');
		}

		await this.updateEnergy(user, userData);

		const increaseAmount = calcUserEarnByTap(user.level, userData.earnByTapBoosterLevel) * count;
		const energyDecrease = BigInt(increaseAmount);

		if (BigInt(userData.energy) < energyDecrease) {
			throw new ForbiddenException('Not enough energy');
		}

		await this.userDataModel.updateOne(
			{ _id: userData._id },
			{
				$set: { 
					energy: userData.energy - energyDecrease,
					lastTapTimestamp: msToSeconds(Date.now()) 
				}
			}
		).exec();

		await this.userModel.updateOne(
			{ _id: user._id },
			{ $set: { balance: user.balance + BigInt(increaseAmount) } }
		).exec();
		await this.statsService.incrementTotalTaps(count);
		await this.statsService.incrementTotalBalance(increaseAmount);
		return this.getUserAllData(userData.telegramId);
	}

	async claimDailyBonus(userRequest: UserRequestDto): Promise<UserResponseDto> {
		const initData = userRequest.initData;
		const user = await this.getUserByTelegramId(`${initData.user.id}`);
		const userData = await this.getUserDataByTelegramId(`${initData.user.id}`);

		if (!userData) {
			throw new NotFoundException('User not found');
		}

		const now = msToSeconds(Date.now());
		if (now - userData.lastDailyClaimTimestamp < 86400) {
			throw new ForbiddenException('You can claim daily bonus only once per 24 hours');
		}

		const dailyBonus = daily[userData.dailyStreak];
		await this.increaseBalance(user, dailyBonus);

		let newDailyStreak = userData.dailyStreak;
		if (now - userData.prevDailyClaimTimestamp > 172800 && userData.dailyStreak > 0) {
			newDailyStreak = 0;
		} else {
			newDailyStreak = Math.min(userData.dailyStreak + 1, daily.length - 1);
		}

		await this.userDataModel.updateOne(
			{ _id: userData._id },
			{
				$set: {
					prevDailyClaimTimestamp: userData.lastDailyClaimTimestamp,
					lastDailyClaimTimestamp: now,
					dailyStreak: newDailyStreak
				}
			}
		).exec();

		return this.getUserAllData(userData.telegramId);
	}

	async getTasks(): Promise<EarnTask[]> {
		return this._getTasks();
	}

	async claimEarnTask(userRequest: UserRequestDto, taskId: number): Promise<UserResponseDto> {
		const initData = userRequest.initData;
		const user = await this.getUserByTelegramId(`${initData.user.id}`);
		const userData = await this.getUserDataByTelegramId(`${initData.user.id}`);
		const earnTask = await this.earnTaskModel.findOne({ id: taskId }).exec();

		if (!user || !userData || !earnTask) {
			throw new NotFoundException('User or task not found');
		}

		const earnTaskIds = userData.earnTaskIds ? userData.earnTaskIds.split(',') : [];

		if (earnTaskIds.includes(`${taskId}`)) {
			throw new ForbiddenException('You have already claimed this task');
		}
		earnTaskIds.push(`${taskId}`);

		await this.userDataModel.updateOne(
			{ _id: userData._id },
			{ $set: { earnTaskIds: earnTaskIds.join(',') } }
		).exec();

		await this.increaseBalance(user, earnTask.reward);

		await this.updateEnergy(user, userData);

		return this.getUserAllData(userData.telegramId);
	}

	async buyMaxEnergyBooster(userRequest: UserRequestDto): Promise<UserResponseDto> {
		const initData = userRequest.initData;
		const user = await this.getUserByTelegramId(`${initData.user.id}`);
		const userData = await this.getUserDataByTelegramId(`${initData.user.id}`);

		if (!user || !userData) {
			throw new NotFoundException('User not found');
		}

		const maxEnergyBooster = maxEnergyBoost[userData.maxEnergyBoosterLevel + 1];
		if (!maxEnergyBooster) {
			throw new ForbiddenException('Max level reached');
		}

		const cost = maxEnergyBooster.cost;

		if (!await this.decreaseBalance(user, cost)) {
			throw new ForbiddenException('Not enough balance');
		}

		await this.userDataModel.updateOne(
			{ _id: userData._id },
			{ $inc: { maxEnergyBoosterLevel: 1 } }
		).exec();

		await this.updateEnergy(user, userData);

		return this.getUserAllData(userData.telegramId);
	}

	async buyEnergyRegenBooster(userRequest: UserRequestDto): Promise<UserResponseDto> {
		const initData = userRequest.initData;
		const user = await this.getUserByTelegramId(`${initData.user.id}`);
		const userData = await this.getUserDataByTelegramId(`${initData.user.id}`);

		if (!user || !userData) {
			throw new NotFoundException('User not found');
		}

		const energyRegenBooster = energyPerSecondBoost[userData.energyPerSecondBoosterLevel + 1];
		if (!energyRegenBooster) {
			throw new ForbiddenException('Max level reached');
		}

		const cost = energyRegenBooster.cost;

		if (!await this.decreaseBalance(user, cost)) {
			throw new ForbiddenException('Not enough balance');
		}

		await this.userDataModel.updateOne(
			{ _id: userData._id },
			{ $inc: { energyPerSecondBoosterLevel: 1 } }
		).exec();

		await this.updateEnergy(user, userData);

		return this.getUserAllData(userData.telegramId);
	}

	async buyEarnTapBooster(userRequest: UserRequestDto): Promise<UserResponseDto> {
		const initData = userRequest.initData;
		const user = await this.getUserByTelegramId(`${initData.user.id}`);
		const userData = await this.getUserDataByTelegramId(`${initData.user.id}`);

		if (!user || !userData) {
			throw new NotFoundException('User not found');
		}

		const earnTapBooster = earnByTapBoost[userData.earnByTapBoosterLevel + 1];
		
		if (!earnTapBooster) {
			throw new ForbiddenException('Max level reached');
		}

		const cost = earnTapBooster.cost;

		Logger.log(cost);
		Logger.log(user.balance);
		Logger.log(user);

		if (!await this.decreaseBalance(user, cost)) {
			Logger.log('Not enough balance, decreaseBalance');
			throw new ForbiddenException('Not enough balance');
		}

		await this.userDataModel.updateOne(
			{ _id: userData._id },
			{ $inc: { earnByTapBoosterLevel: 1 } }
		).exec();

		await this.updateEnergy(user, userData);

		return this.getUserAllData(userData.telegramId);
	}

	async invited(userRequest: UserRequestDto): Promise<InvitedDto[]> {
		const initData = userRequest.initData;
		const user = await this.getUserByTelegramId(`${initData.user.id}`);

		if (!user) {
			throw new NotFoundException('User not found');
		}

		const invited = await this.referralModel.find({ referrerId: user.telegramId }).exec();

		return invited.map(inv => ({
			telegramId: inv.invitedId,
			firstName: inv.firstName,
			lastName: inv.lastName,
			username: inv.username,
			isPremium: inv.invitedPremium,
			reward: inv.reward,
		}));
	}

	async leaderboard(level: number): Promise<LeaderboardResponseDto[]> {
		if (level < 1 || level > Object.keys(levels).length) {
			throw new ForbiddenException('Invalid level');
		}

		const top10Users = await this.userModel
			.find({ level })
			.sort({ balance: -1 })
			.limit(10)
			.exec();

		return top10Users.map(user => ({
			telegramId: user.telegramId,
			firstName: user.firstName,
			lastName: user.lastName,
			username: user.username,
			profilePicture: user.profilePicture,
			isPremium: user.isPremium,
			balance: user.balance.toString(),
		}));
	}

	// TODO: Remove this method in production
	async addEarnTasks(): Promise<EarnTask[]> {
		const tasks = await this._getTasks();

		if (tasks.length) {
			throw new ForbiddenException('Tasks already exist');
		}
		
		const newTasks: any = [
			{
				id: 1,
				link: 'https://x.com/Lovely_finance',
				type: EarnTaskType.X,
				reward: 5000,
			},
			{
				id: 2,
				link: 'https://t.me/lovelyinu_coin',
				type: EarnTaskType.TELEGRAM,
				reward: 1000,
			},
			{
				id: 3,
				link: 'https://www.instagram.com/lovely_finance',
				type: EarnTaskType.INSTAGRAM,
				reward: 1000,
			},
			{
				id: 4,
				link: 'https://www.youtube.com/watch?v=-Hk5_wuljQY',
				type: EarnTaskType.YOUTUBE,
				reward: 1000,
			},
			{
				id: 5,
				link: 'https://discord.gg/37kxK5fSuW',
				type: EarnTaskType.DISCORD,
				reward: 1000,
			},
			{
				id: 6,
				link: 'https://www.tiktok.com/@lovely.finance',
				type: EarnTaskType.TIKTOK,
				reward: 1000,
			},
			{
				id: 7,
				link: 'https://www.reddit.com/r/Lovely_Finance_/s/IX4FpHTY55',
				type: EarnTaskType.REDDIT,
				reward: 1000,
			},
		];

		await this.earnTaskModel.insertMany(newTasks);

		return newTasks;
	}
}