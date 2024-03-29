import mongoose, { isValidObjectId } from "mongoose";
import { User } from "../../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asynchandler.js";
import { deleteFromCloudinary, uploadOnCloudinary } from "../utils/cloudinary.js";
import { Video } from "../../models/video.model.js";
import { ApiResponse } from "../utils/ApiResponse.js";


const publishVideo = asyncHandler(async (req, res) => {
    try {
        const { title, description } = req.body;
        if (!title || !description) {
            throw new ApiError(401, "All fields are required");
        }

        console.log("req.files", req.files);

        if (!req.files?.videoFile || !req.files?.videoFile[0]) {
            throw new ApiError(400, "Video file is required");
        }

        const videoFileLocalPath = req.files.videoFile[0].path;
        const thumbnailLocalPath = req.files?.thumbnail && req.files.thumbnail[0]?.path;

        if (!thumbnailLocalPath) {
            throw new ApiError(400, "Thumbnail is required");
        }

        let videoFile = "";
        if (req.files.videoFile[0].size <= 100 * 1024 * 1024) {
            videoFile = await uploadOnCloudinary(videoFileLocalPath);
        } else {
            throw new ApiError(400, "Upload video less than or equal to 100 MB");
        }

        const thumbnail = await uploadOnCloudinary(thumbnailLocalPath);

        if (!videoFile || !thumbnail) {
            throw new ApiError(400, "Error while uploading on Cloudinary");
        }

        const user = await User.findById(req.user?._id);
        if (!user) {
            throw new ApiError(404, "User not found");
        }

        const video = await Video.create({
            videoFile: {
                url: videoFile.url,
                secure_url: videoFile.secure_url,
                public_id: videoFile.public_id
            },
            thumbnail: {
                url: thumbnail.url,
                secure_url: thumbnail.secure_url,
                public_id: thumbnail.public_id
            },
            title,
            description,
            duration: videoFile.duration,
            views: 0,
            owner: user._id
        });

        res.status(200).json({ status: 200, data: video, message: "Video published successfully" });
    } catch (error) {
        // Handle different types of errors appropriately
        res.status(error.statusCode || 500).json({ status: error.statusCode || 500, message: error.message });
    }
});


const getAllVideos = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, query, sortBy, sortType, userId } = req.query;

    if (!isValidObjectId(userId)) {
        throw new ApiError(401, "Invalid user ID");
    }
    if (!query || !sortBy || !sortType) {
        throw new ApiError(400, "all fields are required");
    }

    const user = User.findById(userId);
    if (!user) {
        throw  ApiError(400, "user not found");
    }

    // Create a text index on the 'query' field
    await Video.createIndexes({ query: "text" });

    const options = {
        page: parseInt(page),
        limit: parseInt(limit),
    };

    const allVideos = Video.aggregate([
        {
            $match: {
                $text: { $search: query }
            }
        },
        {
            $sort: {
                score: { $meta: "textScore" },
                [sortBy]: sortType === 'asc' ? 1 : -1
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "owner",
                pipeline: [{
                    $project: {
                        fullname: 1,
                        username: 1,
                        avatar: 1
                    }
                }]
            },
        }
    ]);

    try {
        const listVideos = await Video.aggregatePaginate(allVideos, options);
        if (listVideos.docs.length === 0) {
            res.status(200).json(new ApiResponse(200, {}, "user does not have videos"));
        }

        res.status(200).json(new ApiResponse(200, listVideos, "videos list fetched successfully"));

    } catch (error) {
        throw new ApiError(400, error.message || "something went wrong with pagination");
    }
});

const getVideoById = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid video id");
    }

    const isVideoExist=await Video.findById(videoId)
    
    if(!isVideoExist){
        throw new ApiError(404,"Video not found")
    }

    const video = await Video.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(videoId)
            },
        },
        {
            $lookup:{
                from:"videos",
                localField:"_id",
                foreignField:"_id",
                as:"video"
            }
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "channel",
                as: "subscribers"
            },
        },
        {
            $lookup: {
                from: "likes",
                localField: "_id",
                foreignField: "video",
                as: "likes"
            },
        },
        {
            $lookup: {
                from: "comments",
                localField: "_id",
                foreignField: "video",
                as: "comments"
            },
        },
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "owner",
                pipeline: [{
                    $project: {
                        fullname: 1,
                        username: 1,
                        avatar: 1
                    }
                }]
            },
        },
        {
            $addFields: {
                owner: {
                    $first: "$owner"
                },
                subscribersCount: {
                    $size: "$subscribers"
                },
                likesCount: {
                    $size: "$likes"
                },
                commentsCount: {
                    $size: "$comments"
                },
                isSubscribed: {
                    $cond: {
                        if: { $in: [req.user?._id, "$subscribers.subscriber"] },
                        then: true,
                        else: false
                    }
                },
                video:{$first:"$video"}

            }
        },
        {
            $project: {
                video: 1,
                owner: 1, subscribersCount: 1, likesCount: 1, commentsCount: 1, isSubscribed: 1, comments: 1
            }
        }

    ])
    console.log("video Details:", video);
    if (!video) {
        throw new ApiError(404, "video not found");
    }

    return res.status(200).json(new ApiResponse(200, video, "video fetched succesfully"))

})



const updateVideo = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid video id");

    }

    const { title, description } = req.body

    if (!title || !description) {
        throw new ApiError(401, "All fields are required")
    }

    const oldVideo = await Video.findById(videoId)

    const thumbnailLocalPath = req.file?.path
    if (!thumbnailLocalPath) {
        throw new ApiError(400, "thumbnail file is required");
    }
    if (!oldVideo) {
        throw new ApiError(404, "video not found");
    }

    const thumbnailResponse = await uploadOnCloudinary(thumbnailLocalPath)
    if (!thumbnailResponse) {
        throw new ApiError(400, "Error while uploading on cloudinary");
    }
    console.log("thumbnail updated successfully", thumbnailResponse.url);

    const thumbnailPublicId = oldVideo.thumbnail.public_id
    const deleteThumbnail = await deleteFromCloudinary(thumbnailPublicId, "image")
    if (!deleteThumbnail) {
        throw new ApiError(400, "Error while deleting file from cloudinary");
    }

    const response = await Video.findByIdAndUpdate(videoId,
        {
            $set: {
                title: title,
                description,
                thumbnail: {
                    url: thumbnailResponse.url,
                    secure_url: thumbnailResponse.secure_url,
                    public_id: thumbnailResponse.public_id
                },
            },
            $inc: {
                views: 1
            }

        }, { new: true }
    )
    if (!response) {
        throw new ApiError(401, "Error occurred while updating video")
    }

    res.status(200).json(new ApiResponse(200, response, "video details updated successfully"))
})

const deleteVideo = asyncHandler(async (req, res) => {

    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid video id");
    }

    const oldVideo = await Video.findById(videoId)
    if (!oldVideo) {
        throw new ApiError(401, "Video not found")
    }
    const videoPublicId = oldVideo?.videoFile.public_id
    const thumbnailPulicId = oldVideo?.thumbnail.public_id

    const deletingVideoFromCloudinary = await deleteFromCloudinary(videoPublicId, "video")
    const deletingThumbnailFromCloudinary = await deleteFromCloudinary(thumbnailPulicId, "image")

    if (!deletingVideoFromCloudinary || !deletingThumbnailFromCloudinary) {
        throw new ApiError(400, "error while deleting files from cloudinary")
    }

    const response = await Video.findByIdAndDelete(videoId)
    if(!response){
        throw new ApiError(400, "Error while deleting video")
    }

    res.status(200).json(new ApiResponse(200, {}, "Video file deleted successfully"))

})



export { publishVideo, getVideoById, updateVideo, deleteVideo, getAllVideos }